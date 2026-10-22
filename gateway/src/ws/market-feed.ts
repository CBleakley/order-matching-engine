// Fans market data out to the authenticated connections, coalesced: changes
// are collected as they happen and flushed on a fixed tick (100 ms by
// default), so a burst of trades costs each connection at most one `candles`,
// one `stats` and one `position` per tick.
//
// A flush carries only what changed since the previous one: the bars touched
// in each interval (the newest version of each), the stats if any trade
// happened, and a `position` P&L refresh for traders holding a position when
// the last price moved. Every part of it replaces state on the client (bars
// by `start`), so a connection that just received a snapshot may safely get
// bars the snapshot already held.
//
// Each connection decides what it can take (see ClientConnection's
// flushMarketData): a slow one skips flushes and catches up with a snapshot.
// The tick runs even when nothing changed, so that slow connections are
// checked regularly.
import type { CandleBar, Interval, Position, Stats } from '@ome/shared';

import type { BarChange } from '../market/candles.js';
import type { MarketData } from '../market/market-data.js';
import type { TraderBook } from '../orders/trader-book.js';
import type { HubConnection, SessionHub } from './session-hub.js';

export const DEFAULT_FLUSH_INTERVAL_MS = 100;

export interface MarketUpdate {
  // Changed bars per interval, oldest first; intervals with no change are absent.
  readonly bars: ReadonlyMap<Interval, readonly CandleBar[]>;
  // The current stats if a trade happened since the last flush.
  readonly stats: Stats | undefined;
  // A P&L refresh for the trader, if the last price moved and they hold a position.
  positionOf(traderId: number): Position | undefined;
}

export interface FeedConnection extends HubConnection {
  flushMarketData(update: MarketUpdate): void;
}

export interface MarketFeedOptions {
  readonly hub: Pick<SessionHub<FeedConnection>, 'authenticated'>;
  readonly marketData: Pick<MarketData, 'on' | 'off' | 'stats'>;
  readonly traderBook: Pick<TraderBook, 'position'>;
  readonly flushIntervalMs?: number;
}

export class MarketFeed {
  readonly #options: MarketFeedOptions;
  // Bars changed since the last flush, per interval, keyed by start.
  readonly #bars = new Map<Interval, Map<number, CandleBar>>();
  #statsChanged = false;
  // The last price as of the previous flush, to tell when P&L moved.
  #lastPrice: number | null;
  #timer: NodeJS.Timeout | undefined;

  readonly #onBars = (changes: readonly BarChange[]): void => {
    for (const { interval, bar } of changes) {
      let bars = this.#bars.get(interval);
      if (bars === undefined) {
        bars = new Map();
        this.#bars.set(interval, bars);
      }
      // Bar starts only grow, so insertion order stays oldest first.
      bars.set(bar.start, bar);
    }
  };

  readonly #onStats = (): void => {
    this.#statsChanged = true;
  };

  // Every connection gets a snapshot after a rebuild, so pending changes are moot.
  readonly #onReset = (): void => {
    this.#bars.clear();
    this.#statsChanged = false;
    this.#lastPrice = this.#options.marketData.stats().last;
  };

  constructor(options: MarketFeedOptions) {
    this.#options = options;
    this.#lastPrice = options.marketData.stats().last;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    const { marketData } = this.#options;
    marketData.on('bars', this.#onBars);
    marketData.on('stats', this.#onStats);
    marketData.on('reset', this.#onReset);
    this.#timer = setInterval(() => {
      this.flush();
    }, this.#options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    const { marketData } = this.#options;
    marketData.off('bars', this.#onBars);
    marketData.off('stats', this.#onStats);
    marketData.off('reset', this.#onReset);
  }

  // Sends the changes collected since the last flush. Called by the timer.
  flush(): void {
    const { marketData, traderBook } = this.#options;
    const bars = new Map<Interval, CandleBar[]>();
    for (const [interval, changed] of this.#bars) bars.set(interval, [...changed.values()]);
    this.#bars.clear();
    const stats = this.#statsChanged ? marketData.stats() : undefined;
    this.#statsChanged = false;

    const last = marketData.stats().last;
    const priceMoved = last !== this.#lastPrice;
    this.#lastPrice = last;
    // Several connections can share a trader.
    const positions = new Map<number, Position | undefined>();
    const update: MarketUpdate = {
      bars,
      stats,
      positionOf: (traderId) => {
        if (!priceMoved) return undefined;
        if (!positions.has(traderId)) {
          const position = traderBook.position(traderId);
          positions.set(traderId, position.netQty === 0 ? undefined : position);
        }
        return positions.get(traderId);
      },
    };
    for (const connection of this.#options.hub.authenticated()) {
      connection.flushMarketData(update);
    }
  }
}
