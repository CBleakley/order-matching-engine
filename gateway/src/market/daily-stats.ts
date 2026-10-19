// Daily (UTC) header statistics: last price, and the open, high and low since
// 00:00 UTC, with change = last - open (the client derives the percentage).
//
// The day rolls over by the clock, not only by trades: after midnight, until
// the first trade of the new day, open/high/low fall back to the last price
// and change is 0. Nothing is pushed at midnight; a consumer that wants to
// show the rollover without a trade reads current() when it next sends stats.
//
// Trades must be added with non-decreasing times (see MarketData).
import type { Stats } from '@ome/shared';

export const DAY_MS = 86_400_000;

export interface DailyStatsOptions {
  // Milliseconds since the epoch.
  readonly now?: () => number;
}

interface Day {
  readonly index: number; // floor(time / DAY_MS)
  readonly open: number;
  high: number;
  low: number;
}

export class DailyStats {
  readonly #now: () => number;
  #last: number | undefined;
  #lastTimeMs = 0;
  #day: Day | undefined;

  constructor(options: DailyStatsOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  addTrade(price: number, timeMs: number): void {
    const index = Math.floor(timeMs / DAY_MS);
    if (this.#day?.index === index) {
      this.#day.high = Math.max(this.#day.high, price);
      this.#day.low = Math.min(this.#day.low, price);
    } else {
      this.#day = { index, open: price, high: price, low: price };
    }
    this.#last = price;
    this.#lastTimeMs = timeMs;
  }

  current(): Stats {
    const last = this.#last;
    if (last === undefined) return { last: null, open: null, high: null, low: null, change: null };
    // A trade stamped ahead of the gateway's clock still counts as today.
    const today = Math.floor(Math.max(this.#now(), this.#lastTimeMs) / DAY_MS);
    const day = this.#day;
    if (day === undefined || day.index !== today) {
      return { last, open: last, high: last, low: last, change: 0 };
    }
    return { last, open: day.open, high: day.high, low: day.low, change: last - day.open };
  }

  clear(): void {
    this.#last = undefined;
    this.#lastTimeMs = 0;
    this.#day = undefined;
  }
}
