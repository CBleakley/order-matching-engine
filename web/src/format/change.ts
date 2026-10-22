// Price change text as in the design canvas: "+1.25 (+0.88%)", with a true
// minus sign for falls. Shared by the header, the chart tooltip and the
// order panels.
import { ticksToDecimalString } from '@ome/shared';

// The design uses a true minus sign for negative values.
export function signed(text: string, negative: boolean): string {
  return (negative ? '−' : '+') + text;
}

// `change` and `base` are price ticks; the percentage is relative to `base`.
export function formatChange(change: number, base: number, decimals: number): string {
  const negative = change < 0;
  const amount = ticksToDecimalString(Math.abs(change), { priceDecimals: decimals });
  // Percent with two decimals, rounded half away from zero on integer hundredths.
  const hundredths = base === 0 ? 0 : Math.round((Math.abs(change) * 10_000) / base);
  const percent = ticksToDecimalString(hundredths, { priceDecimals: 2 });
  return `${signed(amount, negative)} (${signed(percent, negative)}%)`;
}
