import { INTERVALS, type Stats } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import type {
  EngineSnapshot,
  LiveEvent,
  TradeMessage,
  TradeReplayMessage,
} from '../../src/engine/engine-client.js';
import type { BarChange } from '../../src/market/candles.js';
import { MarketData } from '../../src/market/market-data.js';

const MIDNIGHT = Date.UTC(2026, 9, 19);
const NS = 1_000_000n;

interface TradeSpec {
  readonly price: number;
  readonly qty: number;
  readonly timeMs: number;
}

function tradeFields(spec: TradeSpec, eventSeq: number): Omit<TradeMessage, 'type'> {
  return {
    eventSeq: BigInt(eventSeq),
    ts: BigInt(spec.timeMs) * NS + 123_456n, // sub-millisecond part is dropped
    makerOrderId: 1n,
    takerOrderId: 2n,
    buyerTraderId: 1,
    sellerTraderId: 2,
    price: BigInt(spec.price),
    qty: BigInt(spec.qty),
    aggressorSide: 'buy',
  };
}

const replay = (spec: TradeSpec, seq: number): TradeReplayMessage => ({
  type: 'tradeReplay',
  ...tradeFields(spec, seq),
});
const live = (spec: TradeSpec, seq: number): TradeMessage => ({
  type: 'trade',
  ...tradeFields(spec, seq),
});

function snapshot(trades: readonly TradeReplayMessage[]): EngineSnapshot {
  return {
    engineInstanceId: 1n,
    restingOrders: [],
    trades,
    nextEventSeq: BigInt(trades.length + 1),
  };
}

// Crosses 5s, 1m and 5m boundaries and midnight, with one out-of-order stamp.
const TRADES: readonly TradeSpec[] = [
  { price: 14_200, qty: 3, timeMs: MIDNIGHT - 301_000 },
  { price: 14_210, qty: 1, timeMs: MIDNIGHT - 299_999 },
  { price: 14_190, qty: 5, timeMs: MIDNIGHT - 5_000 },
  { price: 14_250, qty: 2, timeMs: MIDNIGHT },
  { price: 14_240, qty: 4, timeMs: MIDNIGHT - 1 }, // stamped before the previous trade
  { price: 14_300, qty: 1, timeMs: MIDNIGHT + 4_999 },
  { price: 14_280, qty: 2, timeMs: MIDNIGHT + 5_000 },
  { price: 14_260, qty: 7, timeMs: MIDNIGHT + 61_000 },
];

const NOW = (): number => MIDNIGHT + 120_000;

describe('MarketData', () => {
  it('rebuilds from a snapshot and emits reset', () => {
    const market = new MarketData({ now: NOW });
    let resets = 0;
    market.on('reset', () => {
      resets += 1;
    });
    market.applySnapshot(
      snapshot([replay({ price: 14_250, qty: 2, timeMs: MIDNIGHT + 1_000 }, 1)]),
    );
    expect(resets).toBe(1);
    expect(market.bars('5s')).toEqual([
      {
        start: MIDNIGHT,
        open: 14_250,
        high: 14_250,
        low: 14_250,
        close: 14_250,
        volume: 2,
        trades: 1,
      },
    ]);
    expect(market.stats()).toEqual({
      last: 14_250,
      open: 14_250,
      high: 14_250,
      low: 14_250,
      change: 0,
    });
  });

  it('converts nanosecond timestamps to milliseconds', () => {
    const market = new MarketData({ now: NOW });
    market.applySnapshot(snapshot([]));
    market.applyEvent(live({ price: 100, qty: 1, timeMs: MIDNIGHT + 4_999 }, 1));
    expect(market.bars('5s')[0]?.start).toBe(MIDNIGHT);
  });

  it('emits bars and stats for live trades and ignores other events', () => {
    const market = new MarketData({ now: NOW });
    const bars: (readonly BarChange[])[] = [];
    const stats: Stats[] = [];
    market.on('bars', (changes) => bars.push(changes));
    market.on('stats', (s) => stats.push(s));
    market.applySnapshot(snapshot([]));

    const other: LiveEvent = {
      type: 'orderRested',
      eventSeq: 1n,
      ts: BigInt(MIDNIGHT) * NS,
      orderId: 1n,
      traderId: 1,
      side: 'buy',
      price: 100n,
      remainingQty: 1n,
    };
    market.applyEvent(other);
    expect(bars).toEqual([]);
    expect(stats).toEqual([]);

    market.applyEvent(live({ price: 100, qty: 1, timeMs: MIDNIGHT + 1_000 }, 2));
    market.applyEvent(live({ price: 104, qty: 1, timeMs: MIDNIGHT + 2_000 }, 3));
    expect(bars).toHaveLength(2);
    expect(bars[0]?.map((c) => c.interval)).toEqual([...INTERVALS]);
    expect(bars[1]?.every((c) => c.kind === 'updated')).toBe(true);
    expect(stats.at(-1)).toEqual({ last: 104, open: 100, high: 104, low: 100, change: 4 });
  });

  it('replaces its state with each snapshot', () => {
    const market = new MarketData({ now: NOW });
    market.applySnapshot(snapshot([replay({ price: 100, qty: 1, timeMs: MIDNIGHT + 1_000 }, 1)]));
    market.applySnapshot(snapshot([replay({ price: 200, qty: 1, timeMs: MIDNIGHT + 50 }, 1)]));
    expect(market.bars('5s').map((b) => b.open)).toEqual([200]);
    expect(market.stats().last).toBe(200);

    market.applySnapshot(snapshot([]));
    expect(market.bars('1m')).toEqual([]);
    expect(market.stats().last).toBeNull();
  });

  it('does not carry the out-of-order clamp across snapshots', () => {
    const market = new MarketData({ now: NOW });
    market.applySnapshot(snapshot([replay({ price: 100, qty: 1, timeMs: MIDNIGHT + 60_000 }, 1)]));
    market.applySnapshot(snapshot([replay({ price: 100, qty: 1, timeMs: MIDNIGHT + 1_000 }, 1)]));
    expect(market.bars('5s')[0]?.start).toBe(MIDNIGHT);
  });

  it('folds an out-of-order trade into the current bar and day', () => {
    const market = new MarketData({ now: NOW });
    market.applySnapshot(snapshot([]));
    market.applyEvent(live({ price: 100, qty: 1, timeMs: MIDNIGHT }, 1));
    market.applyEvent(live({ price: 90, qty: 2, timeMs: MIDNIGHT - 1 }, 2));
    expect(market.bars('5m')).toEqual([
      { start: MIDNIGHT, open: 100, high: 100, low: 90, close: 90, volume: 3, trades: 2 },
    ]);
    expect(market.stats()).toEqual({ last: 90, open: 100, high: 100, low: 90, change: -10 });
  });

  it('gives the same state from a replay as from the same trades live', () => {
    const replayed = new MarketData({ now: NOW });
    replayed.applySnapshot(snapshot(TRADES.map((t, i) => replay(t, i + 1))));

    const streamed = new MarketData({ now: NOW });
    streamed.applySnapshot(snapshot([]));
    TRADES.forEach((t, i) => {
      streamed.applyEvent(live(t, i + 1));
    });

    for (const interval of INTERVALS) {
      expect(streamed.bars(interval)).toEqual(replayed.bars(interval));
    }
    expect(streamed.stats()).toEqual(replayed.stats());

    // And the result is what the trades imply.
    expect(replayed.bars('5m').map((b) => [b.start, b.volume, b.trades])).toEqual([
      [MIDNIGHT - 600_000, 3, 1],
      [MIDNIGHT - 300_000, 6, 2],
      [MIDNIGHT, 16, 5],
    ]);
    expect(replayed.stats()).toEqual({
      last: 14_260,
      open: 14_250,
      high: 14_300,
      low: 14_240,
      change: 10,
    });
  });
});
