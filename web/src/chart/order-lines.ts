// The viewer's resting orders drawn as dashed price lines, labelled as in the
// design canvas: "BUY 100 @ 142.50 · #1043".
import { formatQty, type OrderView, ticksToDecimalString } from '@ome/shared';
import { type CreatePriceLineOptions, LineStyle } from 'lightweight-charts';

import { ticksToPrice } from './series-data.js';

export interface OrderLineColors {
  readonly up: string;
  readonly down: string;
}

export function orderLineLabel(order: OrderView, decimals: number): string {
  const side = order.side === 'buy' ? 'BUY' : 'SELL';
  const price = ticksToDecimalString(order.priceTicks, { priceDecimals: decimals });
  return `${side} ${formatQty(order.remainingQty)} @ ${price} · #${String(order.orderId)}`;
}

export function orderLineOptions(
  order: OrderView,
  decimals: number,
  colors: OrderLineColors,
): CreatePriceLineOptions {
  return {
    price: ticksToPrice(order.priceTicks, decimals),
    color: order.side === 'buy' ? colors.up : colors.down,
    lineWidth: 1,
    lineStyle: LineStyle.Dashed,
    axisLabelVisible: true,
    title: orderLineLabel(order, decimals),
  };
}
