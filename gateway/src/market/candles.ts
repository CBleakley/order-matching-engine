// Candlestick bars for each chart interval, built from trades.
//
// Bars are aligned to UTC interval boundaries (start % INTERVAL_MS === 0); a
// trade exactly on a boundary opens the new bar. An interval with no trades
// produces no bar, so the chart shows a gap rather than a made-up flat bar.
//
// Trades must be added in eventSeq order with non-decreasing times; MarketData
// clamps out-of-order timestamps so that a late-stamped trade is folded into
// the current bar. A time earlier than the newest bar's start is treated the
// same way here, as a safeguard.
import { INTERVAL_MS, INTERVALS, type CandleBar, type Interval } from '@ome/shared';

import { RingBuffer } from './ring-buffer.js';

// Bars kept per interval.
export const CANDLE_HISTORY = 1000;

export interface CandleTrade {
  readonly price: number; // ticks
  readonly qty: number;
  readonly timeMs: number;
}

export interface BarChange {
  readonly interval: Interval;
  // 'updated': the newest bar changed; 'appended': a new bar was started.
  readonly kind: 'updated' | 'appended';
  readonly bar: CandleBar;
}

export interface CandleAggregatorOptions {
  readonly history?: number;
}

export class CandleAggregator {
  readonly #series: ReadonlyMap<Interval, RingBuffer<CandleBar>>;

  constructor(options: CandleAggregatorOptions = {}) {
    const history = options.history ?? CANDLE_HISTORY;
    this.#series = new Map(INTERVALS.map((interval) => [interval, new RingBuffer(history)]));
  }

  // Folds one trade into every interval's bars and returns what changed.
  addTrade(trade: CandleTrade): BarChange[] {
    return INTERVALS.map((interval) => this.#add(interval, trade));
  }

  // The newest n bars (all by default) for an interval, oldest first.
  bars(interval: Interval, n?: number): CandleBar[] {
    return this.#buffer(interval).toArray(n);
  }

  clear(): void {
    for (const buffer of this.#series.values()) buffer.clear();
  }

  #buffer(interval: Interval): RingBuffer<CandleBar> {
    const buffer = this.#series.get(interval);
    if (buffer === undefined) throw new RangeError(`unknown interval ${interval}`);
    return buffer;
  }

  #add(interval: Interval, { price, qty, timeMs }: CandleTrade): BarChange {
    const buffer = this.#buffer(interval);
    const start = timeMs - (timeMs % INTERVAL_MS[interval]);
    const current = buffer.last();
    if (current !== undefined && start <= current.start) {
      // Bars are immutable once handed out, so replace rather than mutate.
      const bar: CandleBar = Object.freeze({
        start: current.start,
        open: current.open,
        high: Math.max(current.high, price),
        low: Math.min(current.low, price),
        close: price,
        volume: current.volume + qty,
        trades: current.trades + 1,
      });
      buffer.replaceLast(bar);
      return { interval, kind: 'updated', bar };
    }
    const bar: CandleBar = Object.freeze({
      start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: qty,
      trades: 1,
    });
    buffer.push(bar);
    return { interval, kind: 'appended', bar };
  }
}
