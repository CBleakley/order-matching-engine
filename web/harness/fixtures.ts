// A deterministic fake market for the chart harness: a seeded random walk of
// one trade per simulated second, aggregated into bars for every interval the
// way the gateway does (shared/PROTOCOL.md, "Candle bar").
import { type CandleBar, type Interval, INTERVAL_MS, INTERVALS } from '@ome/shared';

// mulberry32: small, fast and good enough for fixture data.
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Trade {
  readonly time: number;
  readonly priceTicks: number;
  readonly qty: number;
}

export class FixtureMarket {
  private readonly random: () => number;
  private readonly bars = new Map<Interval, CandleBar[]>(INTERVALS.map((i) => [i, []]));
  private time: number;
  private price: number;

  // `history` simulated seconds of trades, ending at `endMs`.
  constructor(seed: number, endMs: number, history: number, startPriceTicks = 14250) {
    this.random = seededRandom(seed);
    this.price = startPriceTicks;
    this.time = endMs - history * 1000;
    for (let i = 0; i < history; i++) this.step();
  }

  get lastPriceTicks(): number {
    return this.price;
  }

  get now(): number {
    return this.time;
  }

  // A copy: the store must never see these arrays change.
  barsFor(interval: Interval): CandleBar[] {
    return [...(this.bars.get(interval) ?? [])];
  }

  // Advances one simulated second with one trade; returns the newest bar per interval.
  step(): ReadonlyMap<Interval, CandleBar> {
    this.time += 1000;
    const move = Math.round((this.random() - 0.5) * 12);
    this.price = Math.max(1, this.price + move);
    const trade: Trade = {
      time: this.time,
      priceTicks: this.price,
      qty: 1 + Math.floor(this.random() * 400),
    };
    const changed = new Map<Interval, CandleBar>();
    for (const interval of INTERVALS) changed.set(interval, this.record(interval, trade));
    return changed;
  }

  private record(interval: Interval, trade: Trade): CandleBar {
    const bars = this.bars.get(interval) ?? [];
    const start = trade.time - (trade.time % INTERVAL_MS[interval]);
    const last = bars.at(-1);
    const bar: CandleBar =
      last?.start === start
        ? {
            ...last,
            high: Math.max(last.high, trade.priceTicks),
            low: Math.min(last.low, trade.priceTicks),
            close: trade.priceTicks,
            volume: last.volume + trade.qty,
            trades: last.trades + 1,
          }
        : {
            start,
            open: trade.priceTicks,
            high: trade.priceTicks,
            low: trade.priceTicks,
            close: trade.priceTicks,
            volume: trade.qty,
            trades: 1,
          };
    if (last?.start === start) bars[bars.length - 1] = bar;
    else bars.push(bar);
    this.bars.set(interval, bars);
    return bar;
  }
}
