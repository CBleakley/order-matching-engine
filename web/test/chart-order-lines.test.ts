import { LineStyle } from 'lightweight-charts';
import { describe, expect, it } from 'vitest';

import { orderLineLabel, orderLineOptions } from '../src/chart/order-lines.js';
import { order } from './messages.js';

const COLORS = { up: '#up', down: '#down' };

describe('order line labels', () => {
  it('matches the design canvas', () => {
    expect(
      orderLineLabel(order(1043, { originalQty: 100, remainingQty: 100, priceTicks: 14250 }), 2),
    ).toBe('BUY 100 @ 142.50 · #1043');
  });

  it('shows the remaining quantity, grouped, for sells too', () => {
    const partial = order(7, {
      side: 'sell',
      priceTicks: 15005,
      originalQty: 12_000,
      filledQty: 1_500,
      remainingQty: 10_500,
    });
    expect(orderLineLabel(partial, 2)).toBe('SELL 10,500 @ 150.05 · #7');
  });
});

describe('order line options', () => {
  it('draws a dashed line at the order price in the side colour', () => {
    expect(orderLineOptions(order(1, { priceTicks: 14200 }), 2, COLORS)).toEqual({
      price: 142,
      color: '#up',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'BUY 10 @ 142.00 · #1',
    });
    expect(orderLineOptions(order(2, { side: 'sell' }), 2, COLORS).color).toBe('#down');
  });
});
