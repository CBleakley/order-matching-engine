// Order entry for authenticated sessions: the gateway-side checks on
// placeOrder, cancelOrder and cancelAll, and forwarding to the engine.
//
// Input arrives already validated against the public schemas (the WebSocket
// layer parses every frame first). Business rules are checked here, and a
// violation is answered with orderReject without contacting the engine:
//
//   placeOrder:  engine available, session rate limit, quantity <= maxOrderQty,
//                price within the instrument range and the band around the
//                last trade, clientOrderId not already in flight, open orders
//                (resting plus in flight) below the cap.
//   cancelOrder: engine available, session rate limit, the order is one of
//                the session's resting orders. The engine's ownership check
//                stays as a backstop.
//   cancelAll:   one cancel per resting order, each taking a rate-limit token.
//
// Limits apply per session (trader ID), across all of its connections.
// Successful cancels get no reply here: the engine's OrderCancelled becomes an
// orderUpdate from the TraderBook.
import {
  INSTRUMENT,
  REJECT_REASON_TEXT,
  type ClientMessageOf,
  type RejectReason,
  type ServerMessageOf,
} from '@ome/shared';

import type { EngineClient } from '../engine/engine-client.js';
import type { TokenBucketLimiter } from '../session/token-bucket.js';
import { rejectFromEngine, rejectFromError, type MappedReject } from './reject-mapping.js';
import type { TraderBook } from './trader-book.js';

export type OrderAck = Omit<ServerMessageOf<'orderAck'>, 'seq'>;
export type OrderReject = Omit<ServerMessageOf<'orderReject'>, 'seq'>;
export type OrderReply = OrderAck | OrderReject;
export type ReplyFn = (reply: OrderReply) => void;

export interface OrderEntryLimits {
  readonly maxOpenOrdersPerSession: number;
  readonly priceBandPercent: number;
}

export interface OrderEntryOptions {
  readonly engine: Pick<EngineClient, 'submit' | 'cancel' | 'status'>;
  readonly openOrders: Pick<TraderBook, 'isRestingFor' | 'ordersOf' | 'countOf'>;
  // The last trade price in ticks, or null if the instrument has never traded.
  readonly lastPrice: () => number | null;
  readonly limits: OrderEntryLimits;
  // Keyed by trader ID; shared by orders and cancels.
  readonly limiter: TokenBucketLimiter;
}

export class OrderEntry {
  readonly #engine: OrderEntryOptions['engine'];
  readonly #openOrders: OrderEntryOptions['openOrders'];
  readonly #lastPrice: () => number | null;
  readonly #limits: OrderEntryLimits;
  readonly #limiter: TokenBucketLimiter;
  // clientOrderIds of submits awaiting the engine's reply, per trader.
  readonly #inFlight = new Map<number, Set<string>>();

  constructor(options: OrderEntryOptions) {
    this.#engine = options.engine;
    this.#openOrders = options.openOrders;
    this.#lastPrice = options.lastPrice;
    this.#limits = options.limits;
    this.#limiter = options.limiter;
  }

  // Calls `reply` exactly once, with orderAck or orderReject.
  placeOrder(traderId: number, message: ClientMessageOf<'placeOrder'>, reply: ReplyFn): void {
    const { clientOrderId } = message;
    const reject = (rejection: MappedReject): void => {
      reply({ type: 'orderReject', clientOrderId, ...rejection });
    };

    const problem = this.#checkPlace(traderId, message);
    if (problem !== undefined) {
      reject(problem);
      return;
    }

    let inFlight = this.#inFlight.get(traderId);
    if (inFlight === undefined) {
      inFlight = new Set();
      this.#inFlight.set(traderId, inFlight);
    }
    inFlight.add(clientOrderId);
    const settle = (): void => {
      inFlight.delete(clientOrderId);
      if (inFlight.size === 0 && this.#inFlight.get(traderId) === inFlight) {
        this.#inFlight.delete(traderId);
      }
    };

    this.#engine
      .submit({
        traderId,
        side: message.side,
        price: BigInt(message.priceTicks),
        qty: BigInt(message.qty),
      })
      .then(
        (result) => {
          settle();
          if (result.type === 'orderAccepted') {
            // Engine order IDs count up from 1, far below 2^53.
            reply({ type: 'orderAck', clientOrderId, orderId: Number(result.orderId) });
          } else {
            reject(rejectFromEngine(result.reason));
          }
        },
        (error: unknown) => {
          settle();
          reject(rejectFromError(error));
        },
      );
  }

  // Calls `reply` only if the cancel is rejected.
  cancelOrder(traderId: number, message: ClientMessageOf<'cancelOrder'>, reply: ReplyFn): void {
    const orderId = message.orderId;
    if (!this.#engine.status.ready) {
      reply(cancelReject(orderId, simple('engineUnavailable')));
      return;
    }
    if (!this.#limiter.take(traderId).allowed) {
      reply(cancelReject(orderId, simple('rateLimited')));
      return;
    }
    if (!this.#openOrders.isRestingFor(traderId, BigInt(orderId))) {
      reply(cancelReject(orderId, simple('unknownOrder')));
      return;
    }
    this.#forwardCancel(traderId, orderId, reply);
  }

  // Cancels each of the session's resting orders, oldest first. Calls `reply`
  // for each cancel that is rejected.
  cancelAll(traderId: number, reply: ReplyFn): void {
    const orderIds = this.#openOrders.ordersOf(traderId);
    if (orderIds.length === 0) return;
    if (!this.#engine.status.ready) {
      for (const orderId of orderIds) {
        reply(cancelReject(Number(orderId), simple('engineUnavailable')));
      }
      return;
    }
    for (const orderId of orderIds) {
      if (this.#limiter.take(traderId).allowed) {
        this.#forwardCancel(traderId, Number(orderId), reply);
      } else {
        reply(cancelReject(Number(orderId), simple('rateLimited')));
      }
    }
  }

  #checkPlace(traderId: number, message: ClientMessageOf<'placeOrder'>): MappedReject | undefined {
    if (!this.#engine.status.ready) return simple('engineUnavailable');
    if (!this.#limiter.take(traderId).allowed) return simple('rateLimited');

    const { qty, priceTicks, clientOrderId } = message;
    if (qty > INSTRUMENT.maxOrderQty) {
      return {
        reason: 'qtyOutOfRange',
        message: `Quantity must be between 1 and ${String(INSTRUMENT.maxOrderQty)}`,
      };
    }
    if (priceTicks < INSTRUMENT.minPriceTicks || priceTicks > INSTRUMENT.maxPriceTicks) {
      return simple('priceOutOfRange');
    }
    // Before the first trade the band is centred on the reference price.
    const last = this.#lastPrice() ?? INSTRUMENT.referencePriceTicks;
    const band = this.#limits.priceBandPercent;
    // |price - last| / last > band / 100, in exact integer arithmetic: prices
    // are at most maxPriceTicks (1e8), so the products stay below 2^53.
    if (Math.abs(priceTicks - last) * 100 > last * band) {
      return {
        reason: 'priceBand',
        message: `Price must be within ${String(band)}% of the last trade`,
      };
    }

    const inFlight = this.#inFlight.get(traderId);
    if (inFlight?.has(clientOrderId) === true) return simple('duplicateClientOrderId');

    // An order the engine has accepted but whose OrderRested has not arrived
    // yet is briefly in neither count, so the cap can be exceeded by an order
    // or so under unlucky timing. It is a guard against runaway clients, not
    // an exact limit.
    const cap = this.#limits.maxOpenOrdersPerSession;
    if (this.#openOrders.countOf(traderId) + (inFlight?.size ?? 0) >= cap) {
      return {
        reason: 'tooManyOpenOrders',
        message: `Too many open orders (limit ${String(cap)})`,
      };
    }
    return undefined;
  }

  #forwardCancel(traderId: number, orderId: number, reply: ReplyFn): void {
    this.#engine.cancel({ traderId, orderId: BigInt(orderId) }).then(
      (result) => {
        if (result.type === 'orderRejected') {
          reply(cancelReject(orderId, rejectFromEngine(result.reason)));
        }
      },
      (error: unknown) => {
        reply(cancelReject(orderId, rejectFromError(error)));
      },
    );
  }
}

function simple(reason: RejectReason): MappedReject {
  return { reason, message: REJECT_REASON_TEXT[reason] };
}

function cancelReject(orderId: number, rejection: MappedReject): OrderReject {
  return { type: 'orderReject', orderId, ...rejection };
}
