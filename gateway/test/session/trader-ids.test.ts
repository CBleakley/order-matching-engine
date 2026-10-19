import { describe, expect, it } from 'vitest';

import type { EngineSnapshot, LiveEvent } from '../../src/engine/engine-client.js';
import {
  MAX_ALLOCATION_ATTEMPTS,
  MAX_HUMAN_TRADER_ID,
  MIN_HUMAN_TRADER_ID,
  TraderIdExhaustedError,
  TraderIdRegistry,
  type RandomInt,
} from '../../src/session/trader-ids.js';

// Returns the scripted values in order, recording the bounds it was asked for.
function scripted(values: readonly number[]): RandomInt & { calls: [number, number][] } {
  let next = 0;
  const calls: [number, number][] = [];
  const fn = (min: number, max: number): number => {
    calls.push([min, max]);
    const value = values[next++];
    if (value === undefined) {
      throw new Error('script exhausted');
    }
    return value;
  };
  return Object.assign(fn, { calls });
}

const SNAPSHOT: EngineSnapshot = {
  engineInstanceId: 1n,
  restingOrders: [
    {
      type: 'restingOrder',
      orderId: 1n,
      traderId: 2_000_001,
      side: 'buy',
      price: 14_250n,
      originalQty: 10n,
      remainingQty: 10n,
      acceptedAt: 0n,
    },
  ],
  trades: [
    {
      type: 'tradeReplay',
      eventSeq: 1n,
      ts: 0n,
      makerOrderId: 2n,
      takerOrderId: 3n,
      buyerTraderId: 2_000_002,
      sellerTraderId: 2_000_003,
      price: 14_250n,
      qty: 1n,
      aggressorSide: 'sell',
    },
  ],
  nextEventSeq: 2n,
};

describe('TraderIdRegistry', () => {
  it('draws from the human trader ID range', () => {
    const random = scripted([1_500_000]);
    const registry = new TraderIdRegistry(random);
    expect(registry.allocate()).toBe(1_500_000);
    expect(random.calls).toEqual([[MIN_HUMAN_TRADER_ID, MAX_HUMAN_TRADER_ID + 1]]);
    expect(MAX_HUMAN_TRADER_ID + 1).toBe(2 ** 31);
  });

  it('allocates in range with the default random source', () => {
    const registry = new TraderIdRegistry();
    for (let i = 0; i < 100; ++i) {
      const id = registry.allocate();
      expect(id).toBeGreaterThanOrEqual(1_000_000);
      expect(id).toBeLessThan(2 ** 31);
    }
    expect(registry.size).toBe(100);
  });

  it('re-draws on collision with an ID it issued', () => {
    const registry = new TraderIdRegistry(scripted([1_500_000, 1_500_000, 1_500_001]));
    expect(registry.allocate()).toBe(1_500_000);
    expect(registry.allocate()).toBe(1_500_001);
  });

  it('re-draws on collision with IDs from an engine snapshot', () => {
    const registry = new TraderIdRegistry(scripted([2_000_001, 2_000_002, 2_000_003, 2_000_004]));
    registry.addSnapshot(SNAPSHOT);
    expect(registry.allocate()).toBe(2_000_004);
  });

  it('re-draws on collision with IDs from live events and verified tokens', () => {
    const registry = new TraderIdRegistry(scripted([3_000_001, 3_000_002, 3_000_003, 3_000_004]));
    const rested: LiveEvent = {
      type: 'orderRested',
      eventSeq: 1n,
      ts: 0n,
      orderId: 1n,
      traderId: 3_000_001,
      side: 'buy',
      price: 1n,
      remainingQty: 1n,
    };
    const trade: LiveEvent = {
      type: 'trade',
      eventSeq: 2n,
      ts: 0n,
      makerOrderId: 1n,
      takerOrderId: 2n,
      buyerTraderId: 3_000_001,
      sellerTraderId: 3_000_002,
      price: 1n,
      qty: 1n,
      aggressorSide: 'sell',
    };
    registry.addEvent(rested);
    registry.addEvent(trade);
    registry.add(3_000_003);
    expect(registry.allocate()).toBe(3_000_004);
  });

  it(`gives up after ${String(MAX_ALLOCATION_ATTEMPTS)} collisions`, () => {
    const registry = new TraderIdRegistry(
      scripted(Array<number>(MAX_ALLOCATION_ATTEMPTS + 1).fill(1_500_000)),
    );
    registry.add(1_500_000);
    expect(() => registry.allocate()).toThrow(TraderIdExhaustedError);
  });
});
