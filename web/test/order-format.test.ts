import { describe, expect, it } from 'vitest';

import {
  formatDistance,
  formatSide,
  formatSignedMoney,
  positionNote,
} from '../src/orders/format.js';

describe('order display text', () => {
  it('names the side', () => {
    expect(formatSide('buy')).toBe('Buy');
    expect(formatSide('sell')).toBe('Sell');
  });

  it('formats the distance from the last price as a signed percent', () => {
    expect(formatDistance(14300, 14250)).toBe('+0.35%');
    expect(formatDistance(14200, 14250)).toBe('−0.35%');
    expect(formatDistance(12825, 14250)).toBe('−10.00%');
    expect(formatDistance(14250, 14250)).toBe('+0.00%');
    // 1 tick from 1,000,000 rounds to zero and is not shown as negative.
    expect(formatDistance(999_999, 1_000_000)).toBe('+0.00%');
  });

  it('rounds the distance half away from zero', () => {
    // 1 / 200 = 0.5%; 1 / 1600 = 0.0625% -> 0.06%; 1 / 800 = 0.125% -> 0.13%.
    expect(formatDistance(201, 200)).toBe('+0.50%');
    expect(formatDistance(1601, 1600)).toBe('+0.06%');
    expect(formatDistance(799, 800)).toBe('−0.13%');
  });

  it('shows a dash when there is no last price', () => {
    expect(formatDistance(14250, null)).toBe('—');
  });

  it('formats signed money amounts', () => {
    expect(formatSignedMoney(1250, 2)).toBe('+12.50');
    expect(formatSignedMoney(-300, 2)).toBe('−3.00');
    expect(formatSignedMoney(0, 2)).toBe('+0.00');
    expect(formatSignedMoney(123_456_789, 2)).toBe('+1,234,567.89');
  });

  it('pluralises the position note', () => {
    expect(positionNote(3, 2)).toBe('3 fills · 2 open orders');
    expect(positionNote(1, 1)).toBe('1 fill · 1 open order');
    expect(positionNote(0, 0)).toBe('0 fills · 0 open orders');
  });
});
