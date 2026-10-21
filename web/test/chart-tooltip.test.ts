import { describe, expect, it } from 'vitest';

import { tooltipContent } from '../src/chart/tooltip.js';
import { bar } from './messages.js';

const START = new Date(2026, 9, 21, 14, 30, 0).getTime();

describe('tooltipContent', () => {
  it('shows the bar in prices, with the change, range, trades and volume', () => {
    const content = tooltipContent(
      bar(START, 14375, { open: 14250, high: 14400, low: 14200, trades: 1_234, volume: 56_789 }),
      '15s',
      2,
    );
    expect(content).toEqual({
      time: '14:30:00 – 14:30:15',
      open: '142.50',
      high: '144.00',
      low: '142.00',
      close: '143.75',
      change: '+1.25 (+0.88%)',
      range: '2.00',
      trades: '1,234',
      volume: '56,789',
      up: true,
    });
  });

  it('uses a minus sign and the down flag for a falling bar', () => {
    const content = tooltipContent(bar(START, 14000, { open: 14250 }), '5s', 2);
    expect(content.change).toBe('−2.50 (−1.75%)');
    expect(content.up).toBe(false);
  });

  it('treats an unchanged bar as up', () => {
    const content = tooltipContent(bar(START, 14250), '1m', 2);
    expect(content.change).toBe('+0.00 (+0.00%)');
    expect(content.up).toBe(true);
  });

  it('spans the whole interval', () => {
    expect(tooltipContent(bar(START), '1m', 2).time).toBe('14:30:00 – 14:31:00');
    expect(tooltipContent(bar(START), '5m', 2).time).toBe('14:30:00 – 14:35:00');
  });
});
