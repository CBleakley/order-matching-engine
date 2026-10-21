import { describe, expect, it } from 'vitest';

import {
  formatAxisTime,
  formatLocalTime,
  planSeriesUpdate,
  priceFormatter,
  ticksToPrice,
  toCandle,
  toChartTime,
  toVolume,
} from '../src/chart/series-data.js';
import { bar } from './messages.js';

describe('store bars to series data', () => {
  it('converts ticks to prices and milliseconds to UTC seconds', () => {
    const candle = toCandle(
      bar(1_700_000_015_000, 14250, { open: 14200, high: 14275, low: 14190 }),
      2,
    );
    expect(candle).toEqual({
      time: 1_700_000_015,
      open: 142,
      high: 142.75,
      low: 141.9,
      close: 142.5,
    });
  });

  it('honours the instrument decimals', () => {
    expect(ticksToPrice(14250, 0)).toBe(14250);
    expect(ticksToPrice(14250, 3)).toBe(14.25);
    expect(toChartTime(5_000)).toBe(5);
  });

  it('colours volume by candle direction', () => {
    const colors = { up: 'U', down: 'D' };
    expect(toVolume(bar(0, 14250, { open: 14250, volume: 70 }), colors)).toEqual({
      time: 0,
      value: 70,
      color: 'U',
    });
    expect(toVolume(bar(0, 14250, { open: 14300 }), colors).color).toBe('D');
  });
});

describe('planSeriesUpdate', () => {
  const a = bar(5_000);
  const b = bar(10_000);
  const c = bar(15_000);

  it('does nothing when the bars are unchanged', () => {
    const bars = [a, b];
    expect(planSeriesUpdate(bars, bars)).toEqual({ kind: 'none' });
    expect(planSeriesUpdate(bars, [a, b])).toEqual({ kind: 'none' });
  });

  it('updates a replaced last bar in place', () => {
    const b2 = bar(10_000, 14300);
    expect(planSeriesUpdate([a, b], [a, b2])).toEqual({ kind: 'update', bars: [b2] });
  });

  it('appends new bars', () => {
    expect(planSeriesUpdate([a, b], [a, b, c])).toEqual({ kind: 'update', bars: [c] });
  });

  it('sends a replaced last bar before appended ones', () => {
    const b2 = bar(10_000, 14300);
    const d = bar(20_000);
    expect(planSeriesUpdate([a, b], [a, b2, c, d])).toEqual({
      kind: 'update',
      bars: [b2, c, d],
    });
  });

  it('reloads from empty, on an older bar inserted, on shrinking or on a new array', () => {
    expect(planSeriesUpdate([], [a])).toEqual({ kind: 'reset' });
    expect(planSeriesUpdate([b, c], [a, b, c])).toEqual({ kind: 'reset' });
    expect(planSeriesUpdate([a, c], [a, b, c])).toEqual({ kind: 'reset' });
    expect(planSeriesUpdate([a, b], [a])).toEqual({ kind: 'reset' });
    expect(planSeriesUpdate([a, b], [bar(5_000), bar(10_000)])).toEqual({ kind: 'reset' });
  });
});

describe('formatting', () => {
  it('formats axis prices through ticks, without float noise', () => {
    const format = priceFormatter(2);
    expect(format(142.5)).toBe('142.50');
    expect(format(0.1 + 0.2)).toBe('0.30');
    expect(priceFormatter(0)(14250)).toBe('14250');
  });

  it('formats local times, with seconds only for sub-minute intervals', () => {
    const ms = new Date(2026, 9, 21, 9, 5, 7).getTime();
    expect(formatLocalTime(ms)).toBe('09:05:07');
    expect(formatAxisTime(ms, '5s')).toBe('09:05:07');
    expect(formatAxisTime(ms, '15s')).toBe('09:05:07');
    expect(formatAxisTime(ms, '1m')).toBe('09:05');
    expect(formatAxisTime(ms, '5m')).toBe('09:05');
  });
});
