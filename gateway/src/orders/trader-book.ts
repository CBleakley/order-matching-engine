// Each human trader's view of their own activity: open orders, recent fills
// and position, built purely from engine events. Simulated traders (IDs below
// MIN_HUMAN_TRADER_ID) are ignored.
//
// Every engine snapshot rebuilds the state from scratch: open orders from its
// RestingOrder list, fills and position from its TradeReplay list. Live events
// then update it, and each change for a trader is emitted as a `private`
// message for that trader's connections:
//
//   OrderAccepted  the order is tracked but not yet open: while it takes
//                  liquidity it is neither resting nor shown.
//   Trade          for the buyer and the seller (both, for a self-trade): an
//                  orderUpdate if the order filled or is a resting maker, a
//                  fill, and then the position.
//   OrderRested    orderUpdate `resting`, then the position (open order count).
//   OrderCancelled orderUpdate `cancelled`, then the position.
//
// After a gateway restart, fills and the position cover only the trades the
// engine service still retains (its --retention window, 24 hours by default);
// older fills are gone.
//
// Order entry also uses it for the open-order cap and to reject cancels of
// orders that are not the session's own before they reach the engine.
import { EventEmitter } from 'node:events';

import type { Fill, OrderView, Position, ServerMessageOf, Side } from '@ome/shared';

import type {
  EngineSnapshot,
  LiveEvent,
  TradeMessage,
  TradeReplayMessage,
} from '../engine/engine-client.js';
import { RingBuffer } from '../market/ring-buffer.js';
import { MIN_HUMAN_TRADER_ID } from '../session/trader-ids.js';

export const DEFAULT_FILL_HISTORY = 200;

const NS_PER_MS = 1_000_000n;

export type PrivateMessage =
  | Omit<ServerMessageOf<'orderUpdate'>, 'seq'>
  | Omit<ServerMessageOf<'fill'>, 'seq'>
  | Omit<ServerMessageOf<'position'>, 'seq'>;

export interface TraderView {
  // Oldest first.
  readonly openOrders: OrderView[];
  // Newest first.
  readonly fills: Fill[];
  readonly position: Position;
}

export interface TraderBookEvents {
  // A change to one trader's view, for that trader's connections.
  private: [traderId: number, message: PrivateMessage];
}

export interface TraderBookOptions {
  // Fills kept per trader (default DEFAULT_FILL_HISTORY).
  readonly fillHistory?: number;
}

interface OrderState {
  readonly orderId: bigint;
  readonly side: Side;
  readonly price: bigint;
  readonly originalQty: bigint;
  filledQty: bigint;
  readonly placedAtMs: number;
}

interface TraderState {
  // Accepted orders that have not rested (yet): a taker part way through a sweep.
  readonly incoming: Map<bigint, OrderState>;
  // In the order they rested.
  readonly resting: Map<bigint, OrderState>;
  readonly fills: RingBuffer<Fill>;
  netQty: bigint;
  // Sells add price × qty, buys subtract it.
  cash: bigint;
  fillCount: number;
}

type Trade = TradeMessage | TradeReplayMessage;

export class TraderBook extends EventEmitter<TraderBookEvents> {
  readonly #fillHistory: number;
  readonly #traders = new Map<number, TraderState>();
  // The price of the most recent trade by anyone, for P&L.
  #last: bigint | undefined;

  constructor(options: TraderBookOptions = {}) {
    super();
    this.#fillHistory = options.fillHistory ?? DEFAULT_FILL_HISTORY;
  }

  applySnapshot(snapshot: EngineSnapshot): void {
    this.#traders.clear();
    this.#last = undefined;
    // By order ID, which is acceptance order; the snapshot lists bids then asks.
    const orders = [...snapshot.restingOrders].sort((a, b) =>
      a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0,
    );
    for (const order of orders) {
      const trader = this.#trader(order.traderId);
      trader?.resting.set(order.orderId, {
        orderId: order.orderId,
        side: order.side,
        price: order.price,
        originalQty: order.originalQty,
        filledQty: order.originalQty - order.remainingQty,
        placedAtMs: toMs(order.acceptedAt),
      });
    }
    // The resting orders already reflect these trades; only fills, position
    // and the last price are rebuilt from them.
    for (const trade of snapshot.trades) {
      this.#last = trade.price;
      for (const side of sidesOf(trade)) {
        const trader = this.#trader(side.traderId);
        if (trader !== undefined) this.#addFill(trader, trade, side);
      }
    }
  }

  applyEvent(event: LiveEvent): void {
    switch (event.type) {
      case 'orderAccepted':
        this.#trader(event.traderId)?.incoming.set(event.orderId, {
          orderId: event.orderId,
          side: event.side,
          price: event.price,
          originalQty: event.qty,
          filledQty: 0n,
          placedAtMs: toMs(event.ts),
        });
        return;
      case 'trade':
        this.#onTrade(event);
        return;
      case 'orderRested': {
        const trader = this.#trader(event.traderId);
        if (trader === undefined) return;
        let order = trader.incoming.get(event.orderId);
        trader.incoming.delete(event.orderId);
        // Not seen accepted (it should have been): treat the remainder as the whole order.
        order ??= {
          orderId: event.orderId,
          side: event.side,
          price: event.price,
          originalQty: event.remainingQty,
          filledQty: 0n,
          placedAtMs: toMs(event.ts),
        };
        trader.resting.set(event.orderId, order);
        this.#emit(event.traderId, orderUpdate(order, 'resting'));
        this.#emitPosition(event.traderId, trader);
        return;
      }
      case 'orderCancelled': {
        const trader = this.#trader(event.traderId);
        const order = trader?.resting.get(event.orderId);
        if (trader === undefined || order === undefined) return;
        trader.resting.delete(event.orderId);
        this.#emit(event.traderId, orderUpdate(order, 'cancelled'));
        this.#emitPosition(event.traderId, trader);
        return;
      }
      case 'orderRejected':
        return;
    }
  }

  view(traderId: number): TraderView {
    const trader = this.#traders.get(traderId);
    if (trader === undefined) {
      return { openOrders: [], fills: [], position: this.#position(undefined) };
    }
    const openOrders = [...trader.resting.values()]
      .sort((a, b) => (a.orderId < b.orderId ? -1 : 1))
      .map((order) => orderView(order, 'resting'));
    return {
      openOrders,
      fills: trader.fills.toArray().reverse(),
      position: this.#position(trader),
    };
  }

  position(traderId: number): Position {
    return this.#position(this.#traders.get(traderId));
  }

  isRestingFor(traderId: number, orderId: bigint): boolean {
    return this.#traders.get(traderId)?.resting.has(orderId) === true;
  }

  // The trader's resting order IDs, oldest first.
  ordersOf(traderId: number): bigint[] {
    return [...(this.#traders.get(traderId)?.resting.keys() ?? [])];
  }

  countOf(traderId: number): number {
    return this.#traders.get(traderId)?.resting.size ?? 0;
  }

  #onTrade(trade: TradeMessage): void {
    this.#last = trade.price;
    const touched = new Map<number, TraderState>();
    for (const side of sidesOf(trade)) {
      const trader = this.#trader(side.traderId);
      if (trader === undefined) continue;
      touched.set(side.traderId, trader);

      const orders = side.liquidity === 'maker' ? trader.resting : trader.incoming;
      const order = orders.get(side.orderId);
      if (order !== undefined) {
        order.filledQty += trade.qty;
        if (order.filledQty >= order.originalQty) {
          orders.delete(side.orderId);
          this.#emit(side.traderId, orderUpdate(order, 'filled'));
        } else if (side.liquidity === 'maker') {
          this.#emit(side.traderId, orderUpdate(order, 'resting'));
        }
        // A partly filled taker is reported when it rests.
      }

      const fill = this.#addFill(trader, trade, side);
      this.#emit(side.traderId, { type: 'fill', ...fill });
    }
    for (const [traderId, trader] of touched) this.#emitPosition(traderId, trader);
  }

  #addFill(trader: TraderState, trade: Trade, side: TradeSide): Fill {
    const fill: Fill = {
      // Engine order IDs, prices and quantities are far below 2^53.
      orderId: Number(side.orderId),
      side: side.side,
      priceTicks: Number(trade.price),
      qty: Number(trade.qty),
      time: toMs(trade.ts),
      liquidity: side.liquidity,
    };
    trader.fills.push(fill);
    const notional = trade.price * trade.qty;
    if (side.side === 'buy') {
      trader.netQty += trade.qty;
      trader.cash -= notional;
    } else {
      trader.netQty -= trade.qty;
      trader.cash += notional;
    }
    trader.fillCount += 1;
    return fill;
  }

  #position(trader: TraderState | undefined): Position {
    const netQty = trader?.netQty ?? 0n;
    const cash = trader?.cash ?? 0n;
    // With no trade yet, netQty is 0 and the last price does not matter.
    const pnl = cash + netQty * (this.#last ?? 0n);
    return {
      netQty: Number(netQty),
      cashTicks: Number(cash),
      pnlAtLastTicks: Number(pnl),
      fillCount: trader?.fillCount ?? 0,
      openOrderCount: trader?.resting.size ?? 0,
    };
  }

  #emitPosition(traderId: number, trader: TraderState): void {
    this.#emit(traderId, { type: 'position', ...this.#position(trader) });
  }

  #emit(traderId: number, message: PrivateMessage): void {
    this.emit('private', traderId, message);
  }

  // The trader's state, created on first use; undefined for simulated traders.
  #trader(traderId: number): TraderState | undefined {
    if (traderId < MIN_HUMAN_TRADER_ID) return undefined;
    let trader = this.#traders.get(traderId);
    if (trader === undefined) {
      trader = {
        incoming: new Map(),
        resting: new Map(),
        fills: new RingBuffer(this.#fillHistory),
        netQty: 0n,
        cash: 0n,
        fillCount: 0,
      };
      this.#traders.set(traderId, trader);
    }
    return trader;
  }
}

interface TradeSide {
  readonly traderId: number;
  readonly side: Side;
  readonly orderId: bigint;
  readonly liquidity: 'maker' | 'taker';
}

// The buyer's side of a trade, then the seller's.
function sidesOf(trade: Trade): [TradeSide, TradeSide] {
  const side = (s: Side, traderId: number): TradeSide => {
    const taker = trade.aggressorSide === s;
    return {
      traderId,
      side: s,
      orderId: taker ? trade.takerOrderId : trade.makerOrderId,
      liquidity: taker ? 'taker' : 'maker',
    };
  };
  return [side('buy', trade.buyerTraderId), side('sell', trade.sellerTraderId)];
}

function orderView(order: OrderState, status: OrderView['status']): OrderView {
  const remaining = order.originalQty - order.filledQty;
  return {
    orderId: Number(order.orderId),
    side: order.side,
    priceTicks: Number(order.price),
    originalQty: Number(order.originalQty),
    filledQty: Number(order.filledQty),
    remainingQty: Number(remaining > 0n ? remaining : 0n),
    status,
    placedAt: order.placedAtMs,
  };
}

function orderUpdate(
  order: OrderState,
  status: OrderView['status'],
): Omit<ServerMessageOf<'orderUpdate'>, 'seq'> {
  return { type: 'orderUpdate', ...orderView(order, status) };
}

function toMs(ns: bigint): number {
  return Number(ns / NS_PER_MS);
}
