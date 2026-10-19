// Market data derived from the engine's trades: candles for each interval and
// daily stats.
//
// Every engine snapshot rebuilds the state from scratch from its TradeReplay
// list (which includes the simulator's warm-up), so a reconnect or an engine
// restart needs no special handling; live Trade events then update it.
//
// Out-of-order timestamps are folded in, not dropped. Trades are applied in
// eventSeq order, and a trade stamped earlier than the one before it (say, the
// engine's clock stepped back) is treated as happening at that earlier trade's
// time. It lands in the newest bar and the current day, so volume and trade
// counts stay complete and bars never move back in time.
import { EventEmitter } from 'node:events';

import type { CandleBar, Interval, Stats } from '@ome/shared';

import type {
  EngineSnapshot,
  LiveEvent,
  TradeMessage,
  TradeReplayMessage,
} from '../engine/engine-client.js';
import { CandleAggregator, type BarChange } from './candles.js';
import { DailyStats } from './daily-stats.js';

const NS_PER_MS = 1_000_000n;

export interface MarketDataEvents {
  // One trade changed these bars: one change per interval.
  bars: [changes: readonly BarChange[]];
  // The stats after a live trade.
  stats: [stats: Stats];
  // The state was rebuilt from a snapshot; re-read bars() and stats().
  reset: [];
}

export interface MarketDataOptions {
  // Milliseconds since the epoch; drives the daily rollover.
  readonly now?: () => number;
  // Bars kept per interval (default CANDLE_HISTORY).
  readonly history?: number;
}

export class MarketData extends EventEmitter<MarketDataEvents> {
  readonly #candles: CandleAggregator;
  readonly #stats: DailyStats;
  #lastTimeMs: number | undefined;

  constructor(options: MarketDataOptions = {}) {
    super();
    this.#candles = new CandleAggregator(
      options.history === undefined ? {} : { history: options.history },
    );
    this.#stats = new DailyStats(options.now === undefined ? {} : { now: options.now });
  }

  applySnapshot(snapshot: EngineSnapshot): void {
    this.#candles.clear();
    this.#stats.clear();
    this.#lastTimeMs = undefined;
    for (const trade of snapshot.trades) this.#addTrade(trade);
    this.emit('reset');
  }

  applyEvent(event: LiveEvent): void {
    if (event.type !== 'trade') return;
    const changes = this.#addTrade(event);
    this.emit('bars', changes);
    this.emit('stats', this.#stats.current());
  }

  // The newest n bars (all by default) for an interval, oldest first.
  bars(interval: Interval, n?: number): CandleBar[] {
    return this.#candles.bars(interval, n);
  }

  stats(): Stats {
    return this.#stats.current();
  }

  #addTrade(trade: TradeMessage | TradeReplayMessage): BarChange[] {
    // Prices, quantities and millisecond times are well inside 2^53 for the
    // instrument's configured ranges, so Number() is exact.
    const tsMs = Number(trade.ts / NS_PER_MS);
    const timeMs = this.#lastTimeMs === undefined ? tsMs : Math.max(tsMs, this.#lastTimeMs);
    this.#lastTimeMs = timeMs;
    const price = Number(trade.price);
    this.#stats.addTrade(price, timeMs);
    return this.#candles.addTrade({ price, qty: Number(trade.qty), timeMs });
  }
}
