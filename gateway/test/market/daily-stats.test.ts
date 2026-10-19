import { describe, expect, it } from 'vitest';

import { DAY_MS, DailyStats } from '../../src/market/daily-stats.js';

const MIDNIGHT = Date.UTC(2026, 9, 19);

function clock(start: number): { now: () => number; set: (t: number) => void } {
  let time = start;
  return {
    now: () => time,
    set: (t) => {
      time = t;
    },
  };
}

describe('DailyStats', () => {
  it('is all null before the instrument has ever traded', () => {
    const stats = new DailyStats({ now: () => MIDNIGHT });
    expect(stats.current()).toEqual({
      last: null,
      open: null,
      high: null,
      low: null,
      change: null,
    });
  });

  it('tracks open, high, low and change within a day', () => {
    const stats = new DailyStats({ now: () => MIDNIGHT + 10_000 });
    stats.addTrade(100, MIDNIGHT + 1_000);
    stats.addTrade(110, MIDNIGHT + 2_000);
    stats.addTrade(95, MIDNIGHT + 3_000);
    stats.addTrade(104, MIDNIGHT + 4_000);
    expect(stats.current()).toEqual({ last: 104, open: 100, high: 110, low: 95, change: 4 });
  });

  it('opens the day with a trade exactly at midnight', () => {
    const stats = new DailyStats({ now: () => MIDNIGHT + 1 });
    stats.addTrade(100, MIDNIGHT - 1);
    stats.addTrade(90, MIDNIGHT);
    expect(stats.current()).toEqual({ last: 90, open: 90, high: 90, low: 90, change: 0 });
  });

  it('rolls over at midnight by the clock alone', () => {
    const time = clock(MIDNIGHT - 10_000);
    const stats = new DailyStats({ now: time.now });
    stats.addTrade(100, MIDNIGHT - 9_000);
    stats.addTrade(120, MIDNIGHT - 8_000);
    expect(stats.current()).toEqual({ last: 120, open: 100, high: 120, low: 100, change: 20 });
    time.set(MIDNIGHT);
    expect(stats.current()).toEqual({ last: 120, open: 120, high: 120, low: 120, change: 0 });
  });

  it('takes the first trade of the new day as its open', () => {
    const time = clock(MIDNIGHT - 1_000);
    const stats = new DailyStats({ now: time.now });
    stats.addTrade(100, MIDNIGHT - 500);
    time.set(MIDNIGHT + 1_000);
    stats.addTrade(97, MIDNIGHT + 1_000);
    stats.addTrade(99, MIDNIGHT + 2_000);
    expect(stats.current()).toEqual({ last: 99, open: 97, high: 99, low: 97, change: 2 });
  });

  it('ignores earlier days when rebuilt from older trades', () => {
    const stats = new DailyStats({ now: () => MIDNIGHT + 60_000 });
    stats.addTrade(200, MIDNIGHT - DAY_MS + 1);
    stats.addTrade(50, MIDNIGHT - 1);
    stats.addTrade(101, MIDNIGHT + 1_000);
    stats.addTrade(102, MIDNIGHT + 2_000);
    expect(stats.current()).toEqual({ last: 102, open: 101, high: 102, low: 101, change: 1 });
  });

  it('counts a trade stamped ahead of the clock as today', () => {
    const stats = new DailyStats({ now: () => MIDNIGHT - 1 });
    stats.addTrade(100, MIDNIGHT + 5);
    expect(stats.current()).toEqual({ last: 100, open: 100, high: 100, low: 100, change: 0 });
  });

  it('clears', () => {
    const stats = new DailyStats({ now: () => MIDNIGHT });
    stats.addTrade(100, MIDNIGHT);
    stats.clear();
    expect(stats.current().last).toBeNull();
  });
});
