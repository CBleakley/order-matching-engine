// The hover tooltip's text for one candle, as in the design canvas.
import {
  type CandleBar,
  formatQty,
  type Interval,
  INTERVAL_MS,
  ticksToDecimalString,
} from '@ome/shared';

import { formatLocalTime } from './series-data.js';

export interface TooltipContent {
  readonly time: string;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly change: string;
  readonly range: string;
  readonly trades: string;
  readonly volume: string;
  // Close at or above open: drawn in the up colour.
  readonly up: boolean;
}

// The design uses a true minus sign for negative changes.
function signed(text: string, negative: boolean): string {
  return (negative ? '−' : '+') + text;
}

export function tooltipContent(
  bar: CandleBar,
  interval: Interval,
  decimals: number,
): TooltipContent {
  const price = (ticks: number) => ticksToDecimalString(ticks, { priceDecimals: decimals });
  const change = bar.close - bar.open;
  // Percent with two decimals, rounded half away from zero on integer hundredths.
  const hundredths = bar.open === 0 ? 0 : Math.round((Math.abs(change) * 10_000) / bar.open);
  const percent = ticksToDecimalString(hundredths, { priceDecimals: 2 });
  return {
    time: `${formatLocalTime(bar.start)} – ${formatLocalTime(bar.start + INTERVAL_MS[interval])}`,
    open: price(bar.open),
    high: price(bar.high),
    low: price(bar.low),
    close: price(bar.close),
    change: `${signed(price(Math.abs(change)), change < 0)} (${signed(percent, change < 0)}%)`,
    range: price(bar.high - bar.low),
    trades: formatQty(bar.trades),
    volume: formatQty(bar.volume),
    up: change >= 0,
  };
}
