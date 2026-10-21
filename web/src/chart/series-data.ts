// Maps the store's candle bars (integer ticks, millisecond starts) to
// Lightweight Charts series data (decimal prices, UTC seconds), and decides how
// a change to the bars reaches the series: an in-place update for live bars, or
// a full reload for anything else.
import { type CandleBar, type Interval, INTERVAL_MS, ticksToDecimalString } from '@ome/shared';
import type { CandlestickData, HistogramData, Time, UTCTimestamp } from 'lightweight-charts';

export function toChartTime(startMs: number): UTCTimestamp {
  return (startMs / 1000) as UTCTimestamp;
}

export function ticksToPrice(ticks: number, decimals: number): number {
  return ticks / 10 ** decimals;
}

export function toCandle(bar: CandleBar, decimals: number): CandlestickData<UTCTimestamp> {
  return {
    time: toChartTime(bar.start),
    open: ticksToPrice(bar.open, decimals),
    high: ticksToPrice(bar.high, decimals),
    low: ticksToPrice(bar.low, decimals),
    close: ticksToPrice(bar.close, decimals),
  };
}

export interface VolumeColors {
  readonly up: string;
  readonly down: string;
}

export function toVolume(bar: CandleBar, colors: VolumeColors): HistogramData<UTCTimestamp> {
  return {
    time: toChartTime(bar.start),
    value: bar.volume,
    color: bar.close >= bar.open ? colors.up : colors.down,
  };
}

export type SeriesUpdatePlan =
  | { readonly kind: 'none' }
  // Bars to pass to series.update, oldest first; each is the last bar or newer.
  | { readonly kind: 'update'; readonly bars: readonly CandleBar[] }
  | { readonly kind: 'reset' };

// Live `candles` messages only replace the newest bar or append newer ones, and
// the store keeps every other bar object as it was. Anything else (a snapshot,
// an interval switch, an older bar inserted) reloads the series.
export function planSeriesUpdate(
  prev: readonly CandleBar[],
  next: readonly CandleBar[],
): SeriesUpdatePlan {
  if (prev === next) return { kind: 'none' };
  if (prev.length === 0 || next.length < prev.length) return { kind: 'reset' };
  const lastIndex = prev.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    if (prev[i] !== next[i]) return { kind: 'reset' };
  }
  const prevLast = prev[lastIndex];
  const nextLast = next[lastIndex];
  if (prevLast === undefined || nextLast === undefined || prevLast.start !== nextLast.start) {
    return { kind: 'reset' };
  }
  const bars = next.slice(prevLast === nextLast ? prev.length : lastIndex);
  return bars.length === 0 ? { kind: 'none' } : { kind: 'update', bars };
}

// Formats chart prices through the shared tick formatter, so the axis never
// shows floating point noise.
export function priceFormatter(decimals: number): (price: number) => string {
  return (price) =>
    ticksToDecimalString(Math.round(price * 10 ** decimals), { priceDecimals: decimals });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

// Local wall-clock time, HH:MM:SS.
export function formatLocalTime(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Axis labels: seconds only matter for the sub-minute intervals.
export function formatAxisTime(ms: number, interval: Interval): string {
  const time = formatLocalTime(ms);
  return INTERVAL_MS[interval] < 60_000 ? time : time.slice(0, 5);
}

// The chart only ever receives UTCTimestamp times.
export function chartTimeToMs(time: Time): number {
  return typeof time === 'number' ? time * 1000 : 0;
}
