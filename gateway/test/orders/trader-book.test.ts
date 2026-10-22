import type { Side } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import type {
  EngineSnapshot,
  LiveEvent,
  RestingOrderMessage,
  TradeMessage,
} from '../../src/engine/engine-client.js';
import { TraderBook, type PrivateMessage } from '../../src/orders/trader-book.js';

const ALICE = 1_000_001;
const BOB = 1_000_002;
const SIM = 7;
const MS = 1_000_000n;

// Builds live events in eventSeq order, as the engine service sends them.
class Events {
  readonly events: LiveEvent[] = [];
  #seq = 1n;
  #ms = 0;

  accepted(orderId: bigint, traderId: number, side: Side, price: bigint, qty: bigint): this {
    return this.#push({
      type: 'orderAccepted',
      eventSeq: this.#seq,
      ts: this.#ts(),
      clientTag: orderId,
      orderId,
      traderId,
      side,
      price,
      qty,
    });
  }

  rested(orderId: bigint, traderId: number, side: Side, price: bigint, remainingQty: bigint): this {
    return this.#push({
      type: 'orderRested',
      eventSeq: this.#seq,
      ts: this.#ts(),
      orderId,
      traderId,
      side,
      price,
      remainingQty,
    });
  }

  // An order that rests in full on arrival.
  place(orderId: bigint, traderId: number, side: Side, price: bigint, qty: bigint): this {
    return this.accepted(orderId, traderId, side, price, qty).rested(
      orderId,
      traderId,
      side,
      price,
      qty,
    );
  }

  trade(
    taker: { orderId: bigint; traderId: number; side: Side },
    maker: { orderId: bigint; traderId: number },
    price: bigint,
    qty: bigint,
  ): this {
    const takerBuys = taker.side === 'buy';
    return this.#push({
      type: 'trade',
      eventSeq: this.#seq,
      ts: this.#ts(),
      makerOrderId: maker.orderId,
      takerOrderId: taker.orderId,
      buyerTraderId: takerBuys ? taker.traderId : maker.traderId,
      sellerTraderId: takerBuys ? maker.traderId : taker.traderId,
      price,
      qty,
      aggressorSide: taker.side,
    });
  }

  cancelled(orderId: bigint, traderId: number, cancelledQty: bigint): this {
    return this.#push({
      type: 'orderCancelled',
      eventSeq: this.#seq,
      ts: this.#ts(),
      orderId,
      traderId,
      cancelledQty,
    });
  }

  #ts(): bigint {
    this.#ms += 1;
    return BigInt(this.#ms) * MS;
  }

  #push(event: LiveEvent): this {
    this.events.push(event);
    this.#seq += 1n;
    return this;
  }
}

// A book with every message it emitted.
function book(fillHistory?: number): { book: TraderBook; sent: [number, PrivateMessage][] } {
  const traderBook = new TraderBook(fillHistory === undefined ? {} : { fillHistory });
  const sent: [number, PrivateMessage][] = [];
  traderBook.on('private', (traderId, message) => {
    sent.push([traderId, message]);
  });
  return { book: traderBook, sent };
}

function apply(traderBook: TraderBook, events: Events): void {
  for (const event of events.events) traderBook.applyEvent(event);
}

function to(sent: [number, PrivateMessage][], traderId: number): PrivateMessage[] {
  return sent.filter(([id]) => id === traderId).map(([, message]) => message);
}

// The snapshot the engine service would send after `events`: the orders still
// resting (in book order: bids then asks) and every trade as a TradeReplay.
function snapshotAfter(events: readonly LiveEvent[]): EngineSnapshot {
  const resting = new Map<bigint, RestingOrderMessage>();
  const accepted = new Map<bigint, { qty: bigint; ts: bigint }>();
  const trades: TradeMessage[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'orderAccepted':
        accepted.set(event.orderId, { qty: event.qty, ts: event.ts });
        break;
      case 'orderRested': {
        const order = accepted.get(event.orderId);
        resting.set(event.orderId, {
          type: 'restingOrder',
          orderId: event.orderId,
          traderId: event.traderId,
          side: event.side,
          price: event.price,
          originalQty: order?.qty ?? event.remainingQty,
          remainingQty: event.remainingQty,
          acceptedAt: order?.ts ?? event.ts,
        });
        break;
      }
      case 'trade': {
        trades.push(event);
        const maker = resting.get(event.makerOrderId);
        if (maker !== undefined) {
          const remainingQty = maker.remainingQty - event.qty;
          if (remainingQty === 0n) resting.delete(event.makerOrderId);
          else resting.set(event.makerOrderId, { ...maker, remainingQty });
        }
        break;
      }
      case 'orderCancelled':
        resting.delete(event.orderId);
        break;
      case 'orderRejected':
        break;
    }
  }
  const orders = [...resting.values()];
  return {
    engineInstanceId: 1n,
    restingOrders: [
      ...orders.filter((o) => o.side === 'buy').sort((a, b) => Number(b.price - a.price)),
      ...orders.filter((o) => o.side === 'sell').sort((a, b) => Number(a.price - b.price)),
    ],
    trades: trades.map((t) => ({ ...t, type: 'tradeReplay' as const })),
    nextEventSeq: BigInt(events.length + 1),
  };
}

describe('TraderBook order lifecycle', () => {
  it('reports a rest, a partial fill as maker and a cancel', () => {
    const { book: b, sent } = book();
    const events = new Events()
      .place(1n, ALICE, 'sell', 100n, 10n)
      .accepted(2n, SIM, 'buy', 100n, 3n)
      .trade(
        { orderId: 2n, traderId: SIM, side: 'buy' },
        { orderId: 1n, traderId: ALICE },
        100n,
        3n,
      )
      .cancelled(1n, ALICE, 7n);
    apply(b, events);

    const order = { orderId: 1, side: 'sell', priceTicks: 100, originalQty: 10, placedAt: 1 };
    expect(to(sent, ALICE)).toEqual([
      { type: 'orderUpdate', ...order, filledQty: 0, remainingQty: 10, status: 'resting' },
      position({ openOrderCount: 1 }),
      { type: 'orderUpdate', ...order, filledQty: 3, remainingQty: 7, status: 'resting' },
      {
        type: 'fill',
        orderId: 1,
        side: 'sell',
        priceTicks: 100,
        qty: 3,
        time: 4,
        liquidity: 'maker',
      },
      position({ netQty: -3, cashTicks: 300, pnlAtLastTicks: 0, fillCount: 1, openOrderCount: 1 }),
      { type: 'orderUpdate', ...order, filledQty: 3, remainingQty: 7, status: 'cancelled' },
      position({ netQty: -3, cashTicks: 300, pnlAtLastTicks: 0, fillCount: 1 }),
    ]);
    expect(sent.every(([id]) => id === ALICE)).toBe(true);
    expect(b.view(ALICE).openOrders).toEqual([]);
    expect(b.countOf(ALICE)).toBe(0);
  });

  it('reports an order filled on arrival as filled, never resting', () => {
    const { book: b, sent } = book();
    apply(
      b,
      new Events()
        .place(1n, SIM, 'sell', 100n, 10n)
        .accepted(2n, ALICE, 'buy', 105n, 4n)
        .trade(
          { orderId: 2n, traderId: ALICE, side: 'buy' },
          { orderId: 1n, traderId: SIM },
          100n,
          4n,
        ),
    );
    expect(to(sent, ALICE)).toEqual([
      expect.objectContaining({
        type: 'orderUpdate',
        orderId: 2,
        status: 'filled',
        filledQty: 4,
        remainingQty: 0,
        priceTicks: 105,
      }),
      expect.objectContaining({
        type: 'fill',
        orderId: 2,
        side: 'buy',
        qty: 4,
        liquidity: 'taker',
      }),
      position({ netQty: 4, cashTicks: -400, pnlAtLastTicks: 0, fillCount: 1 }),
    ]);
    expect(b.view(ALICE).openOrders).toEqual([]);
  });

  it('reports one fill per maker when a taker sweeps several of the trader’s orders', () => {
    const { book: b, sent } = book();
    const taker = { orderId: 4n, traderId: SIM, side: 'buy' as const };
    apply(
      b,
      new Events()
        .place(1n, ALICE, 'sell', 100n, 2n)
        .place(2n, ALICE, 'sell', 101n, 3n)
        .place(3n, ALICE, 'sell', 102n, 5n)
        .accepted(4n, SIM, 'buy', 102n, 8n)
        .trade(taker, { orderId: 1n, traderId: ALICE }, 100n, 2n)
        .trade(taker, { orderId: 2n, traderId: ALICE }, 101n, 3n)
        .trade(taker, { orderId: 3n, traderId: ALICE }, 102n, 3n),
    );
    const afterSweep = to(sent, ALICE).slice(6);
    expect(afterSweep.filter((m) => m.type === 'fill')).toEqual([
      expect.objectContaining({ orderId: 1, priceTicks: 100, qty: 2, liquidity: 'maker' }),
      expect.objectContaining({ orderId: 2, priceTicks: 101, qty: 3, liquidity: 'maker' }),
      expect.objectContaining({ orderId: 3, priceTicks: 102, qty: 3, liquidity: 'maker' }),
    ]);
    expect(afterSweep.filter((m) => m.type === 'orderUpdate')).toEqual([
      expect.objectContaining({ orderId: 1, status: 'filled', filledQty: 2 }),
      expect.objectContaining({ orderId: 2, status: 'filled', filledQty: 3 }),
      expect.objectContaining({ orderId: 3, status: 'resting', filledQty: 3, remainingQty: 2 }),
    ]);
    expect(b.position(ALICE)).toEqual({
      netQty: -8,
      cashTicks: 200 + 303 + 306,
      pnlAtLastTicks: 200 + 303 + 306 - 8 * 102,
      fillCount: 3,
      openOrderCount: 1,
    });
  });

  it('reports a partly filled taker only once it rests', () => {
    const { book: b, sent } = book();
    const taker = { orderId: 3n, traderId: ALICE, side: 'buy' as const };
    apply(
      b,
      new Events()
        .place(1n, BOB, 'sell', 100n, 2n)
        .place(2n, BOB, 'sell', 101n, 2n)
        .accepted(3n, ALICE, 'buy', 101n, 6n)
        .trade(taker, { orderId: 1n, traderId: BOB }, 100n, 2n)
        .trade(taker, { orderId: 2n, traderId: BOB }, 101n, 2n)
        .rested(3n, ALICE, 'buy', 101n, 2n),
    );
    expect(to(sent, ALICE)).toEqual([
      expect.objectContaining({ type: 'fill', orderId: 3, qty: 2, liquidity: 'taker' }),
      expect.objectContaining({ type: 'position', netQty: 2 }),
      expect.objectContaining({ type: 'fill', orderId: 3, qty: 2, liquidity: 'taker' }),
      expect.objectContaining({ type: 'position', netQty: 4 }),
      expect.objectContaining({
        type: 'orderUpdate',
        orderId: 3,
        status: 'resting',
        originalQty: 6,
        filledQty: 4,
        remainingQty: 2,
      }),
      expect.objectContaining({ type: 'position', netQty: 4, openOrderCount: 1 }),
    ]);
    expect(b.position(BOB)).toMatchObject({ netQty: -4, cashTicks: 402, openOrderCount: 0 });
  });

  it('counts a self-trade on both sides', () => {
    const { book: b, sent } = book();
    apply(
      b,
      new Events()
        .place(1n, ALICE, 'sell', 100n, 5n)
        .accepted(2n, ALICE, 'buy', 100n, 5n)
        .trade(
          { orderId: 2n, traderId: ALICE, side: 'buy' },
          { orderId: 1n, traderId: ALICE },
          100n,
          5n,
        ),
    );
    expect(to(sent, ALICE).slice(2)).toEqual([
      expect.objectContaining({ type: 'orderUpdate', orderId: 2, status: 'filled' }),
      expect.objectContaining({ type: 'fill', orderId: 2, side: 'buy', liquidity: 'taker' }),
      expect.objectContaining({ type: 'orderUpdate', orderId: 1, status: 'filled' }),
      expect.objectContaining({ type: 'fill', orderId: 1, side: 'sell', liquidity: 'maker' }),
      position({ fillCount: 2 }),
    ]);
    expect(b.view(ALICE).fills.map((f) => f.liquidity)).toEqual(['maker', 'taker']);
  });

  it('ignores simulated traders', () => {
    const { book: b, sent } = book();
    apply(
      b,
      new Events()
        .place(1n, SIM, 'sell', 100n, 5n)
        .accepted(2n, SIM + 1, 'buy', 100n, 5n)
        .trade(
          { orderId: 2n, traderId: SIM + 1, side: 'buy' },
          { orderId: 1n, traderId: SIM },
          100n,
          5n,
        ),
    );
    expect(sent).toEqual([]);
    expect(b.view(SIM)).toEqual({ openOrders: [], fills: [], position: position({}, false) });
  });

  it('ignores cancels of unknown orders', () => {
    const { book: b, sent } = book();
    apply(b, new Events().cancelled(42n, ALICE, 1n));
    expect(sent).toEqual([]);
  });
});

describe('TraderBook position', () => {
  it('values a short position at the last trade, whoever traded', () => {
    const { book: b } = book();
    apply(
      b,
      new Events()
        .place(1n, SIM, 'buy', 100n, 10n)
        .accepted(2n, ALICE, 'sell', 100n, 10n)
        .trade(
          { orderId: 2n, traderId: ALICE, side: 'sell' },
          { orderId: 1n, traderId: SIM },
          100n,
          10n,
        )
        // Alice is short 10 from 100: a rise to 103 loses her 30.
        .place(3n, SIM, 'sell', 103n, 1n)
        .accepted(4n, SIM, 'buy', 103n, 1n)
        .trade(
          { orderId: 4n, traderId: SIM, side: 'buy' },
          { orderId: 3n, traderId: SIM },
          103n,
          1n,
        ),
    );
    expect(b.position(ALICE)).toEqual({
      netQty: -10,
      cashTicks: 1000,
      pnlAtLastTicks: -30,
      fillCount: 1,
      openOrderCount: 0,
    });
  });

  it('nets buys and sells through flat to long', () => {
    const { book: b } = book();
    const events = new Events()
      .place(1n, SIM, 'buy', 100n, 4n)
      .accepted(2n, ALICE, 'sell', 100n, 4n)
      .trade(
        { orderId: 2n, traderId: ALICE, side: 'sell' },
        { orderId: 1n, traderId: SIM },
        100n,
        4n,
      )
      .place(3n, SIM, 'sell', 98n, 10n)
      .accepted(4n, ALICE, 'buy', 98n, 10n)
      .trade(
        { orderId: 4n, traderId: ALICE, side: 'buy' },
        { orderId: 3n, traderId: SIM },
        98n,
        10n,
      );
    apply(b, events);
    // Sold 4 at 100 (+400), bought 10 at 98 (-980): long 6, marked at 98.
    expect(b.position(ALICE)).toEqual({
      netQty: 6,
      cashTicks: -580,
      pnlAtLastTicks: -580 + 6 * 98,
      fillCount: 2,
      openOrderCount: 0,
    });
  });

  it('is all zero for an unknown trader', () => {
    expect(new TraderBook().position(ALICE)).toEqual(position({}, false));
  });
});

describe('TraderBook fills', () => {
  it('keeps the newest fills, newest first, but counts them all', () => {
    const { book: b } = book(3);
    const events = new Events().place(1n, ALICE, 'sell', 100n, 5n);
    for (let i = 0; i < 5; ++i) {
      const id = BigInt(10 + i);
      events
        .accepted(id, SIM, 'buy', 100n, 1n)
        .trade(
          { orderId: id, traderId: SIM, side: 'buy' },
          { orderId: 1n, traderId: ALICE },
          100n,
          1n,
        );
    }
    apply(b, events);
    const { fills, position: p } = b.view(ALICE);
    expect(fills.map((f) => f.time)).toEqual([12, 10, 8]);
    expect(p).toMatchObject({ fillCount: 5, netQty: -5 });
  });
});

describe('TraderBook open orders for order entry', () => {
  it('tracks an order from rest through partial fill to full fill', () => {
    const { book: b } = book();
    const events = new Events().place(1n, ALICE, 'buy', 100n, 10n);
    apply(b, events);
    expect(b.isRestingFor(ALICE, 1n)).toBe(true);
    const sell = (id: bigint, qty: bigint) =>
      new Events()
        .accepted(id, SIM, 'sell', 100n, qty)
        .trade(
          { orderId: id, traderId: SIM, side: 'sell' },
          { orderId: 1n, traderId: ALICE },
          100n,
          qty,
        );
    apply(b, sell(2n, 4n));
    expect(b.countOf(ALICE)).toBe(1);
    apply(b, sell(3n, 6n));
    expect(b.isRestingFor(ALICE, 1n)).toBe(false);
    expect(b.countOf(ALICE)).toBe(0);
  });

  it('does not count an order that is still taking liquidity', () => {
    const { book: b } = book();
    apply(b, new Events().accepted(1n, ALICE, 'buy', 100n, 10n));
    expect(b.countOf(ALICE)).toBe(0);
    expect(b.isRestingFor(ALICE, 1n)).toBe(false);
  });

  it('knows who owns each order', () => {
    const { book: b } = book();
    apply(b, new Events().place(1n, ALICE, 'buy', 100n, 10n));
    expect(b.isRestingFor(BOB, 1n)).toBe(false);
    expect(b.isRestingFor(ALICE, 2n)).toBe(false);
  });

  it('lists a trader’s orders in the order they rested', () => {
    const { book: b } = book();
    const events = new Events();
    for (const id of [5n, 3n, 9n]) events.place(id, ALICE, 'buy', 100n, 1n);
    events.place(4n, BOB, 'buy', 100n, 1n);
    apply(b, events);
    expect(b.ordersOf(ALICE)).toEqual([5n, 3n, 9n]);
    expect(b.ordersOf(BOB)).toEqual([4n]);
    expect(b.ordersOf(1_000_003)).toEqual([]);
  });
});

describe('TraderBook snapshots', () => {
  it('rebuilds from a snapshot, discarding previous state', () => {
    const { book: b, sent } = book();
    apply(b, new Events().place(1n, ALICE, 'buy', 100n, 10n));
    sent.length = 0;
    b.applySnapshot(
      snapshotAfter(
        new Events().place(9n, BOB, 'buy', 99n, 2n).place(7n, BOB, 'sell', 101n, 3n).events,
      ),
    );
    expect(sent).toEqual([]);
    expect(b.countOf(ALICE)).toBe(0);
    expect(b.ordersOf(BOB)).toEqual([7n, 9n]);
    expect(b.view(BOB).openOrders.map((o) => o.orderId)).toEqual([7, 9]);
  });

  it('builds the same views from a snapshot as from the live events', () => {
    const traders = [ALICE, BOB];
    const e = new Events()
      // Alice rests two sells and a buy; Bob rests a sell.
      .place(1n, ALICE, 'sell', 101n, 5n)
      .place(2n, ALICE, 'sell', 102n, 5n)
      .place(3n, ALICE, 'buy', 98n, 4n)
      .place(4n, BOB, 'sell', 101n, 3n)
      // A simulated buyer sweeps Alice's 101, Bob's 101 and part of Alice's 102.
      .accepted(5n, SIM, 'buy', 102n, 10n);
    const sweep = { orderId: 5n, traderId: SIM, side: 'buy' as const };
    e.trade(sweep, { orderId: 1n, traderId: ALICE }, 101n, 5n)
      .trade(sweep, { orderId: 4n, traderId: BOB }, 101n, 3n)
      .trade(sweep, { orderId: 2n, traderId: ALICE }, 102n, 2n)
      // Bob buys, partly filled against Alice's 102, then rests the rest.
      .accepted(6n, BOB, 'buy', 102n, 5n)
      .trade(
        { orderId: 6n, traderId: BOB, side: 'buy' },
        { orderId: 2n, traderId: ALICE },
        102n,
        3n,
      )
      .rested(6n, BOB, 'buy', 102n, 2n)
      // Alice sells into her own buy and Bob's: a self-trade, then Bob.
      .accepted(7n, ALICE, 'sell', 98n, 3n);
    const aliceSells = { orderId: 7n, traderId: ALICE, side: 'sell' as const };
    e.trade(aliceSells, { orderId: 6n, traderId: BOB }, 102n, 2n)
      .trade(aliceSells, { orderId: 3n, traderId: ALICE }, 98n, 1n)
      // Alice cancels the rest of her buy; Bob rests a sell that stays.
      .cancelled(3n, ALICE, 3n)
      .place(8n, BOB, 'sell', 105n, 7n);

    const live = new TraderBook();
    for (const event of e.events) live.applyEvent(event);
    const rebuilt = new TraderBook();
    rebuilt.applySnapshot(snapshotAfter(e.events));

    for (const trader of traders) {
      expect(rebuilt.view(trader)).toEqual(live.view(trader));
      expect(rebuilt.ordersOf(trader)).toEqual(live.ordersOf(trader));
    }
    // A sanity check that the history did something.
    expect(live.view(ALICE).fills).toHaveLength(6);
    expect(live.view(BOB).openOrders.map((o) => o.orderId)).toEqual([8]);
  });
});

function position(
  fields: Partial<{
    netQty: number;
    cashTicks: number;
    pnlAtLastTicks: number;
    fillCount: number;
    openOrderCount: number;
  }>,
  message = true,
): Record<string, unknown> {
  return {
    ...(message ? { type: 'position' } : {}),
    netQty: 0,
    cashTicks: 0,
    pnlAtLastTicks: 0,
    fillCount: 0,
    openOrderCount: 0,
    ...fields,
  };
}
