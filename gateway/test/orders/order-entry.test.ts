import { INSTRUMENT, type ClientMessageOf } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import {
  EngineDisconnectedError,
  EngineTimeoutError,
  EngineUnavailableError,
  type CancelReply,
  type CancelRequest,
  type EngineStatus,
  type SubmitReply,
  type SubmitRequest,
} from '../../src/engine/engine-client.js';
import { OrderEntry, type OrderReply } from '../../src/orders/order-entry.js';
import { TraderBook } from '../../src/orders/trader-book.js';
import { TokenBucketLimiter } from '../../src/session/token-bucket.js';

const ALICE = 1_000_001;
const BOB = 1_000_002;
const REFERENCE = INSTRUMENT.referencePriceTicks;

interface Call<Req, Rep> {
  readonly request: Req;
  resolve: (reply: Rep) => void;
  reject: (error: Error) => void;
}

class StubEngine {
  status: EngineStatus = { connected: true, ready: true, engineInstanceId: 1n };
  readonly submits: Call<SubmitRequest, SubmitReply>[] = [];
  readonly cancels: Call<CancelRequest, CancelReply>[] = [];

  submit(request: SubmitRequest): Promise<SubmitReply> {
    return new Promise((resolve, reject) => this.submits.push({ request, resolve, reject }));
  }

  cancel(request: CancelRequest): Promise<CancelReply> {
    return new Promise((resolve, reject) => this.cancels.push({ request, resolve, reject }));
  }
}

function harness(options: { cap?: number; band?: number; burst?: number; last?: number } = {}) {
  const engine = new StubEngine();
  const openOrders = new TraderBook();
  const state: { last: number | null } = { last: options.last ?? null };
  const entry = new OrderEntry({
    engine,
    openOrders,
    lastPrice: () => state.last,
    limits: {
      maxOpenOrdersPerSession: options.cap ?? 50,
      priceBandPercent: options.band ?? 10,
    },
    limiter: new TokenBucketLimiter({
      ratePerSecond: 10,
      burst: options.burst ?? 100,
      now: () => 0,
    }),
  });
  const replies: OrderReply[] = [];
  const reply = (r: OrderReply): void => {
    replies.push(r);
  };
  return { engine, openOrders, state, entry, replies, reply };
}

let tag = 0;
function order(
  overrides: Partial<ClientMessageOf<'placeOrder'>> = {},
): ClientMessageOf<'placeOrder'> {
  tag += 1;
  return {
    type: 'placeOrder',
    clientOrderId: `c${String(tag)}`,
    side: 'buy',
    qty: 10,
    priceTicks: REFERENCE,
    ...overrides,
  };
}

function rest(registry: TraderBook, orderId: bigint, traderId: number): void {
  registry.applyEvent({
    type: 'orderRested',
    eventSeq: 1n,
    ts: 0n,
    orderId,
    traderId,
    side: 'buy',
    price: 100n,
    remainingQty: 5n,
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function accepted(request: SubmitRequest, orderId: bigint): SubmitReply {
  return {
    type: 'orderAccepted',
    eventSeq: 1n,
    ts: 0n,
    clientTag: 1n,
    orderId,
    traderId: request.traderId,
    side: request.side,
    price: request.price,
    qty: request.qty,
  };
}

function rejected(reason: Extract<SubmitReply, { type: 'orderRejected' }>['reason']) {
  return {
    type: 'orderRejected',
    eventSeq: 1n,
    ts: 0n,
    clientTag: 1n,
    orderId: 0n,
    traderId: ALICE,
    reason,
  } as const;
}

describe('OrderEntry.placeOrder', () => {
  it('forwards a valid order and acks with the engine order ID', async () => {
    const h = harness();
    const message = order({ side: 'sell', qty: 3, priceTicks: REFERENCE + 5 });
    h.entry.placeOrder(ALICE, message, h.reply);
    expect(h.engine.submits).toHaveLength(1);
    const call = h.engine.submits[0];
    expect(call?.request).toEqual({
      traderId: ALICE,
      side: 'sell',
      price: BigInt(REFERENCE + 5),
      qty: 3n,
    });
    call?.resolve(accepted(call.request, 42n));
    await flush();
    expect(h.replies).toEqual([
      { type: 'orderAck', clientOrderId: message.clientOrderId, orderId: 42 },
    ]);
  });

  it.each([
    ['invalidPrice', 'priceOutOfRange'],
    ['priceOutOfRange', 'priceOutOfRange'],
    ['invalidQuantity', 'qtyOutOfRange'],
    ['qtyOutOfRange', 'qtyOutOfRange'],
    ['duplicateOrderId', 'internal'],
  ] as const)('maps engine reject %s to %s', async (engineReason, reason) => {
    const h = harness();
    const message = order();
    h.entry.placeOrder(ALICE, message, h.reply);
    h.engine.submits[0]?.resolve(rejected(engineReason));
    await flush();
    expect(h.replies).toEqual([
      expect.objectContaining({
        type: 'orderReject',
        clientOrderId: message.clientOrderId,
        reason,
      }),
    ]);
  });

  it.each([
    [new EngineDisconnectedError('lost'), 'engineUnavailable'],
    [new EngineUnavailableError('down'), 'engineUnavailable'],
    [new EngineTimeoutError('slow'), 'engineUnavailable'],
    [new RangeError('bad'), 'internal'],
  ] as const)('maps request failure %o to %s', async (error, reason) => {
    const h = harness();
    h.entry.placeOrder(ALICE, order(), h.reply);
    h.engine.submits[0]?.reject(error);
    await flush();
    expect(h.replies).toEqual([expect.objectContaining({ type: 'orderReject', reason })]);
  });

  it('rejects without contacting the engine while it is unavailable', () => {
    const h = harness();
    h.engine.status = { connected: false, ready: false, engineInstanceId: 1n };
    h.entry.placeOrder(ALICE, order(), h.reply);
    expect(h.engine.submits).toHaveLength(0);
    expect(h.replies).toEqual([
      expect.objectContaining({ type: 'orderReject', reason: 'engineUnavailable' }),
    ]);
  });

  it('rejects quantities above maxOrderQty', () => {
    const h = harness();
    h.entry.placeOrder(ALICE, order({ qty: INSTRUMENT.maxOrderQty }), h.reply);
    h.entry.placeOrder(ALICE, order({ qty: INSTRUMENT.maxOrderQty + 1 }), h.reply);
    expect(h.engine.submits).toHaveLength(1);
    expect(h.replies).toEqual([
      expect.objectContaining({
        reason: 'qtyOutOfRange',
        message: `Quantity must be between 1 and ${String(INSTRUMENT.maxOrderQty)}`,
      }),
    ]);
  });

  it('rejects prices outside the instrument range', () => {
    const h = harness({ band: 100, last: INSTRUMENT.maxPriceTicks });
    h.entry.placeOrder(ALICE, order({ priceTicks: INSTRUMENT.maxPriceTicks + 1 }), h.reply);
    expect(h.engine.submits).toHaveLength(0);
    expect(h.replies).toEqual([expect.objectContaining({ reason: 'priceOutOfRange' })]);
  });

  it('allows prices exactly on the band edges and rejects one tick beyond', () => {
    const h = harness({ last: 14_250 });
    // 10% of 14250 is 1425 ticks.
    for (const priceTicks of [12_825, 15_675]) {
      h.entry.placeOrder(ALICE, order({ priceTicks }), h.reply);
    }
    expect(h.engine.submits).toHaveLength(2);
    for (const priceTicks of [12_824, 15_676]) {
      h.entry.placeOrder(ALICE, order({ priceTicks }), h.reply);
    }
    expect(h.engine.submits).toHaveLength(2);
    expect(h.replies).toEqual([
      expect.objectContaining({
        reason: 'priceBand',
        message: 'Price must be within 10% of the last trade',
      }),
      expect.objectContaining({ reason: 'priceBand' }),
    ]);
  });

  it('centres the band on the last trade, or the reference price before any trade', () => {
    const h = harness();
    h.entry.placeOrder(ALICE, order({ priceTicks: Math.floor(REFERENCE * 1.2) }), h.reply);
    expect(h.replies).toEqual([expect.objectContaining({ reason: 'priceBand' })]);
    h.state.last = Math.floor(REFERENCE * 1.15);
    h.entry.placeOrder(ALICE, order({ priceTicks: Math.floor(REFERENCE * 1.2) }), h.reply);
    expect(h.engine.submits).toHaveLength(1);
  });

  it('rejects a clientOrderId that is still in flight, and allows it again after the reply', async () => {
    const h = harness();
    h.entry.placeOrder(ALICE, order({ clientOrderId: 'same' }), h.reply);
    h.entry.placeOrder(ALICE, order({ clientOrderId: 'same' }), h.reply);
    // Another session may use the same ID.
    h.entry.placeOrder(BOB, order({ clientOrderId: 'same' }), h.reply);
    expect(h.engine.submits).toHaveLength(2);
    expect(h.replies).toEqual([
      expect.objectContaining({ clientOrderId: 'same', reason: 'duplicateClientOrderId' }),
    ]);
    const call = h.engine.submits[0];
    call?.resolve(accepted(call.request, 1n));
    await flush();
    h.entry.placeOrder(ALICE, order({ clientOrderId: 'same' }), h.reply);
    expect(h.engine.submits).toHaveLength(3);
  });

  it('caps resting plus in-flight orders per session', async () => {
    const h = harness({ cap: 3 });
    rest(h.openOrders, 1n, ALICE);
    rest(h.openOrders, 2n, ALICE);
    rest(h.openOrders, 3n, BOB);
    h.entry.placeOrder(ALICE, order(), h.reply);
    h.entry.placeOrder(ALICE, order(), h.reply);
    expect(h.engine.submits).toHaveLength(1);
    expect(h.replies).toEqual([
      expect.objectContaining({
        reason: 'tooManyOpenOrders',
        message: 'Too many open orders (limit 3)',
      }),
    ]);
    // A rejected order frees its slot.
    h.engine.submits[0]?.resolve(rejected('invalidPrice'));
    await flush();
    h.entry.placeOrder(ALICE, order(), h.reply);
    expect(h.engine.submits).toHaveLength(2);
  });

  it('rate-limits each session, before any other check', () => {
    const h = harness({ burst: 2 });
    h.entry.placeOrder(ALICE, order(), h.reply);
    h.entry.placeOrder(ALICE, order({ qty: INSTRUMENT.maxOrderQty + 1 }), h.reply);
    h.entry.placeOrder(ALICE, order(), h.reply);
    h.entry.placeOrder(BOB, order(), h.reply);
    expect(h.engine.submits.map((c) => c.request.traderId)).toEqual([ALICE, BOB]);
    expect(h.replies.map((r) => r.type === 'orderReject' && r.reason)).toEqual([
      'qtyOutOfRange',
      'rateLimited',
    ]);
  });
});

describe('OrderEntry.cancelOrder', () => {
  it('forwards a cancel of the session’s own resting order and stays quiet on success', async () => {
    const h = harness();
    rest(h.openOrders, 5n, ALICE);
    h.entry.cancelOrder(ALICE, { type: 'cancelOrder', orderId: 5 }, h.reply);
    expect(h.engine.cancels.map((c) => c.request)).toEqual([{ traderId: ALICE, orderId: 5n }]);
    h.engine.cancels[0]?.resolve({
      type: 'orderCancelled',
      eventSeq: 1n,
      ts: 0n,
      orderId: 5n,
      traderId: ALICE,
      cancelledQty: 5n,
    });
    await flush();
    expect(h.replies).toEqual([]);
  });

  it('rejects locally a cancel of another session’s order', () => {
    const h = harness();
    rest(h.openOrders, 5n, BOB);
    h.entry.cancelOrder(ALICE, { type: 'cancelOrder', orderId: 5 }, h.reply);
    h.entry.cancelOrder(ALICE, { type: 'cancelOrder', orderId: 6 }, h.reply);
    expect(h.engine.cancels).toHaveLength(0);
    expect(h.replies).toEqual([
      expect.objectContaining({ type: 'orderReject', orderId: 5, reason: 'unknownOrder' }),
      expect.objectContaining({ type: 'orderReject', orderId: 6, reason: 'unknownOrder' }),
    ]);
  });

  it('maps the engine’s ownership backstop', async () => {
    const h = harness();
    rest(h.openOrders, 5n, ALICE);
    h.entry.cancelOrder(ALICE, { type: 'cancelOrder', orderId: 5 }, h.reply);
    h.engine.cancels[0]?.resolve({ ...rejected('notOwner'), orderId: 5n });
    await flush();
    expect(h.replies).toEqual([
      expect.objectContaining({ type: 'orderReject', orderId: 5, reason: 'notOwner' }),
    ]);
  });

  it('rejects while the engine is unavailable', () => {
    const h = harness();
    rest(h.openOrders, 5n, ALICE);
    h.engine.status = { connected: false, ready: false, engineInstanceId: 1n };
    h.entry.cancelOrder(ALICE, { type: 'cancelOrder', orderId: 5 }, h.reply);
    expect(h.engine.cancels).toHaveLength(0);
    expect(h.replies).toEqual([expect.objectContaining({ reason: 'engineUnavailable' })]);
  });

  it('shares the rate limit with orders', () => {
    const h = harness({ burst: 1 });
    rest(h.openOrders, 5n, ALICE);
    h.entry.placeOrder(ALICE, order(), h.reply);
    h.entry.cancelOrder(ALICE, { type: 'cancelOrder', orderId: 5 }, h.reply);
    expect(h.engine.cancels).toHaveLength(0);
    expect(h.replies).toEqual([expect.objectContaining({ orderId: 5, reason: 'rateLimited' })]);
  });
});

describe('OrderEntry.cancelAll', () => {
  it('cancels each of the session’s resting orders, oldest first', () => {
    const h = harness();
    rest(h.openOrders, 3n, ALICE);
    rest(h.openOrders, 1n, ALICE);
    rest(h.openOrders, 2n, BOB);
    h.entry.cancelAll(ALICE, h.reply);
    expect(h.engine.cancels.map((c) => c.request)).toEqual([
      { traderId: ALICE, orderId: 3n },
      { traderId: ALICE, orderId: 1n },
    ]);
    expect(h.replies).toEqual([]);
  });

  it('rejects the cancels beyond the rate limit', () => {
    const h = harness({ burst: 2 });
    for (const id of [1n, 2n, 3n, 4n]) rest(h.openOrders, id, ALICE);
    h.entry.cancelAll(ALICE, h.reply);
    expect(h.engine.cancels.map((c) => c.request.orderId)).toEqual([1n, 2n]);
    expect(h.replies).toEqual([
      expect.objectContaining({ orderId: 3, reason: 'rateLimited' }),
      expect.objectContaining({ orderId: 4, reason: 'rateLimited' }),
    ]);
  });

  it('does nothing when the session has no resting orders', () => {
    const h = harness();
    h.engine.status = { connected: false, ready: false, engineInstanceId: 1n };
    h.entry.cancelAll(ALICE, h.reply);
    expect(h.replies).toEqual([]);
  });

  it('rejects each order while the engine is unavailable', () => {
    const h = harness();
    rest(h.openOrders, 1n, ALICE);
    rest(h.openOrders, 2n, ALICE);
    h.engine.status = { connected: false, ready: false, engineInstanceId: 1n };
    h.entry.cancelAll(ALICE, h.reply);
    expect(h.engine.cancels).toHaveLength(0);
    expect(h.replies.map((r) => r.type === 'orderReject' && [r.orderId, r.reason])).toEqual([
      [1, 'engineUnavailable'],
      [2, 'engineUnavailable'],
    ]);
  });
});
