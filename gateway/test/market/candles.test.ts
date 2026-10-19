import { INTERVALS } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import { CANDLE_HISTORY, CandleAggregator } from '../../src/market/candles.js';

// 2026-10-19T12:00:00Z, aligned to every interval.
const T0 = Date.UTC(2026, 9, 19, 12, 0, 0);

describe('CandleAggregator', () => {
  it('starts with no bars', () => {
    const candles = new CandleAggregator();
    for (const interval of INTERVALS) expect(candles.bars(interval)).toEqual([]);
  });

  it('builds open, high, low, close, volume and trade count', () => {
    const candles = new CandleAggregator();
    candles.addTrade({ price: 100, qty: 2, timeMs: T0 + 100 });
    candles.addTrade({ price: 105, qty: 1, timeMs: T0 + 200 });
    candles.addTrade({ price: 98, qty: 4, timeMs: T0 + 300 });
    candles.addTrade({ price: 101, qty: 3, timeMs: T0 + 400 });
    expect(candles.bars('5s')).toEqual([
      { start: T0, open: 100, high: 105, low: 98, close: 101, volume: 10, trades: 4 },
    ]);
  });

  it('reports one change per interval, appended then updated', () => {
    const candles = new CandleAggregator();
    const first = candles.addTrade({ price: 100, qty: 1, timeMs: T0 });
    expect(first.map((c) => [c.interval, c.kind])).toEqual(
      INTERVALS.map((interval) => [interval, 'appended']),
    );
    const second = candles.addTrade({ price: 101, qty: 1, timeMs: T0 + 1 });
    expect(second.map((c) => c.kind)).toEqual(INTERVALS.map(() => 'updated'));
    expect(second[0]?.bar).toEqual({
      start: T0,
      open: 100,
      high: 101,
      low: 100,
      close: 101,
      volume: 2,
      trades: 2,
    });
  });

  it('opens a new bar for a trade exactly on a boundary', () => {
    const candles = new CandleAggregator();
    candles.addTrade({ price: 100, qty: 1, timeMs: T0 + 4_999 });
    const changes = candles.addTrade({ price: 101, qty: 1, timeMs: T0 + 5_000 });
    expect(changes.find((c) => c.interval === '5s')?.kind).toBe('appended');
    expect(changes.find((c) => c.interval === '15s')?.kind).toBe('updated');
    expect(candles.bars('5s').map((b) => [b.start, b.close])).toEqual([
      [T0, 100],
      [T0 + 5_000, 101],
    ]);
  });

  it('aligns each interval to its own UTC boundary', () => {
    const candles = new CandleAggregator();
    const time = T0 + 4 * 60_000 + 37_123; // 12:04:37.123
    candles.addTrade({ price: 100, qty: 1, timeMs: time });
    expect(candles.bars('5s')[0]?.start).toBe(T0 + 4 * 60_000 + 35_000);
    expect(candles.bars('15s')[0]?.start).toBe(T0 + 4 * 60_000 + 30_000);
    expect(candles.bars('1m')[0]?.start).toBe(T0 + 4 * 60_000);
    expect(candles.bars('5m')[0]?.start).toBe(T0);
  });

  it('leaves a gap for intervals with no trades', () => {
    const candles = new CandleAggregator();
    candles.addTrade({ price: 100, qty: 1, timeMs: T0 });
    candles.addTrade({ price: 102, qty: 1, timeMs: T0 + 20_000 });
    expect(candles.bars('5s').map((b) => b.start)).toEqual([T0, T0 + 20_000]);
  });

  it('folds a trade timed before the newest bar into that bar', () => {
    const candles = new CandleAggregator();
    candles.addTrade({ price: 100, qty: 1, timeMs: T0 + 5_000 });
    const changes = candles.addTrade({ price: 90, qty: 2, timeMs: T0 + 1_000 });
    expect(changes.every((c) => c.kind === 'updated')).toBe(true);
    expect(candles.bars('5s')).toEqual([
      { start: T0 + 5_000, open: 100, high: 100, low: 90, close: 90, volume: 3, trades: 2 },
    ]);
  });

  it('keeps the newest CANDLE_HISTORY bars per interval', () => {
    expect(CANDLE_HISTORY).toBe(1000);
    const candles = new CandleAggregator();
    const count = CANDLE_HISTORY + 5;
    for (let i = 0; i < count; ++i) {
      candles.addTrade({ price: 100 + i, qty: 1, timeMs: T0 + i * 5_000 });
    }
    const bars = candles.bars('5s');
    expect(bars).toHaveLength(CANDLE_HISTORY);
    expect(bars[0]?.start).toBe(T0 + 5 * 5_000);
    expect(bars.at(-1)?.start).toBe(T0 + (count - 1) * 5_000);
    // Coarser intervals hold fewer, wider bars.
    expect(candles.bars('5m')).toHaveLength(Math.ceil((count * 5_000) / 300_000));
  });

  it('returns the last n bars and evicts with a small history', () => {
    const candles = new CandleAggregator({ history: 3 });
    for (let i = 0; i < 5; ++i)
      candles.addTrade({ price: 100 + i, qty: 1, timeMs: T0 + i * 5_000 });
    expect(candles.bars('5s').map((b) => b.open)).toEqual([102, 103, 104]);
    expect(candles.bars('5s', 2).map((b) => b.open)).toEqual([103, 104]);
  });

  it('hands out bars that later trades do not change', () => {
    const candles = new CandleAggregator();
    candles.addTrade({ price: 100, qty: 1, timeMs: T0 });
    const [before] = candles.bars('5s');
    candles.addTrade({ price: 110, qty: 1, timeMs: T0 + 1 });
    expect(before?.close).toBe(100);
    expect(Object.isFrozen(before)).toBe(true);
  });

  it('clears', () => {
    const candles = new CandleAggregator();
    candles.addTrade({ price: 100, qty: 1, timeMs: T0 });
    candles.clear();
    for (const interval of INTERVALS) expect(candles.bars(interval)).toEqual([]);
  });
});
