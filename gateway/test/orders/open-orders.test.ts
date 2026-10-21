import { describe, expect, it } from 'vitest';

import type { EngineSnapshot, LiveEvent } from '../../src/engine/engine-client.js';
import { OpenOrderRegistry } from '../../src/orders/open-orders.js';

const ALICE = 1_000_001;
const BOB = 1_000_002;
const SIM = 7;

let seq = 1n;

function rested(orderId: bigint, traderId: number, remainingQty: bigint): LiveEvent {
  return {
    type: 'orderRested',
    eventSeq: seq++,
    ts: 0n,
    orderId,
    traderId,
    side: 'buy',
    price: 100n,
    remainingQty,
  };
}

function trade(makerOrderId: bigint, qty: bigint): LiveEvent {
  return {
    type: 'trade',
    eventSeq: seq++,
    ts: 0n,
    makerOrderId,
    takerOrderId: 999n,
    buyerTraderId: ALICE,
    sellerTraderId: SIM,
    price: 100n,
    qty,
    aggressorSide: 'sell',
  };
}

function cancelled(orderId: bigint, traderId: number): LiveEvent {
  return { type: 'orderCancelled', eventSeq: seq++, ts: 0n, orderId, traderId, cancelledQty: 1n };
}

function snapshot(orders: [bigint, number, bigint][]): EngineSnapshot {
  return {
    engineInstanceId: 1n,
    nextEventSeq: 1n,
    trades: [],
    restingOrders: orders.map(([orderId, traderId, remainingQty]) => ({
      type: 'restingOrder',
      orderId,
      traderId,
      side: 'sell',
      price: 100n,
      originalQty: remainingQty,
      remainingQty,
      acceptedAt: 0n,
    })),
  };
}

describe('OpenOrderRegistry', () => {
  it('tracks an order from rest through partial fill to full fill', () => {
    const registry = new OpenOrderRegistry();
    registry.applyEvent(rested(1n, ALICE, 10n));
    expect(registry.isRestingFor(ALICE, 1n)).toBe(true);
    registry.applyEvent(trade(1n, 4n));
    expect(registry.countOf(ALICE)).toBe(1);
    registry.applyEvent(trade(1n, 6n));
    expect(registry.isRestingFor(ALICE, 1n)).toBe(false);
    expect(registry.countOf(ALICE)).toBe(0);
  });

  it('removes cancelled orders', () => {
    const registry = new OpenOrderRegistry();
    registry.applyEvent(rested(1n, ALICE, 10n));
    registry.applyEvent(rested(2n, ALICE, 5n));
    registry.applyEvent(cancelled(1n, ALICE));
    expect(registry.ordersOf(ALICE)).toEqual([2n]);
  });

  it('knows who owns each order', () => {
    const registry = new OpenOrderRegistry();
    registry.applyEvent(rested(1n, ALICE, 10n));
    expect(registry.isRestingFor(BOB, 1n)).toBe(false);
    expect(registry.isRestingFor(ALICE, 2n)).toBe(false);
  });

  it('lists a trader’s orders oldest first', () => {
    const registry = new OpenOrderRegistry();
    for (const id of [5n, 3n, 9n]) registry.applyEvent(rested(id, ALICE, 1n));
    registry.applyEvent(rested(4n, BOB, 1n));
    expect(registry.ordersOf(ALICE)).toEqual([5n, 3n, 9n]);
    expect(registry.ordersOf(BOB)).toEqual([4n]);
    expect(registry.ordersOf(1_000_003)).toEqual([]);
  });

  it('ignores simulated traders', () => {
    const registry = new OpenOrderRegistry();
    registry.applyEvent(rested(1n, SIM, 10n));
    registry.applyEvent(trade(1n, 1n));
    expect(registry.countOf(SIM)).toBe(0);
    expect(registry.isRestingFor(SIM, 1n)).toBe(false);
  });

  it('rebuilds from a snapshot, discarding previous state', () => {
    const registry = new OpenOrderRegistry();
    registry.applyEvent(rested(1n, ALICE, 10n));
    registry.applySnapshot(
      snapshot([
        [7n, BOB, 3n],
        [8n, SIM, 3n],
        [9n, BOB, 2n],
      ]),
    );
    expect(registry.countOf(ALICE)).toBe(0);
    expect(registry.ordersOf(BOB)).toEqual([7n, 9n]);
    registry.applyEvent(trade(7n, 3n));
    expect(registry.ordersOf(BOB)).toEqual([9n]);
  });

  it('ignores events for unknown orders', () => {
    const registry = new OpenOrderRegistry();
    registry.applyEvent(trade(42n, 1n));
    registry.applyEvent(cancelled(42n, ALICE));
    expect(registry.countOf(ALICE)).toBe(0);
  });
});
