// Display text for the viewer's orders, fills and position, as in the design canvas.
import { formatMoney, type Side, ticksToDecimalString } from '@ome/shared';

// Shown where a value is not known yet.
export const NO_VALUE = '—';

export function formatSide(side: Side): string {
  return side === 'buy' ? 'Buy' : 'Sell';
}

// The design uses a true minus sign for negative values.
function signed(text: string, negative: boolean): string {
  return (negative ? '−' : '+') + text;
}

// How far a limit price is from the last trade, in percent with two decimals:
// "+0.35%". Rounded half away from zero on integer hundredths of a percent.
export function formatDistance(priceTicks: number, lastTicks: number | null): string {
  if (lastTicks === null || lastTicks <= 0) return NO_VALUE;
  const diff = priceTicks - lastTicks;
  const hundredths = Math.round((Math.abs(diff) * 10_000) / lastTicks);
  return `${signed(ticksToDecimalString(hundredths, { priceDecimals: 2 }), diff < 0 && hundredths > 0)}%`;
}

// A money amount in ticks with an explicit sign: "+12.50", "−3.00".
export function formatSignedMoney(amountTicks: number, priceDecimals: number): string {
  return signed(formatMoney(Math.abs(amountTicks), { priceDecimals }), amountTicks < 0);
}

// "3 fills · 2 open orders".
export function positionNote(fillCount: number, openOrderCount: number): string {
  const fills = `${String(fillCount)} ${fillCount === 1 ? 'fill' : 'fills'}`;
  const orders = `${String(openOrderCount)} open ${openOrderCount === 1 ? 'order' : 'orders'}`;
  return `${fills} · ${orders}`;
}
