import priceFixture from '@ome/protocol/fixtures/prices.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';

import { INSTRUMENT } from '../src/instrument.js';
import {
  formatMoney,
  formatQty,
  parseDecimalToTicks,
  ticksToDecimalString,
  type PriceParseError,
} from '../src/price.js';

describe.each(priceFixture.groups)('shared price fixture: $name', (group) => {
  const config = { ...INSTRUMENT, ...group.config };

  it.each(group.roundTrip)('"$decimal" <-> $ticks', ({ decimal, ticks }) => {
    expect(parseDecimalToTicks(decimal, config)).toEqual({ ok: true, ticks });
    expect(ticksToDecimalString(ticks, config)).toBe(decimal);
  });

  it.each(group.parse)('parses "$input" as $ticks', ({ input, ticks }) => {
    expect(parseDecimalToTicks(input, config)).toEqual({ ok: true, ticks });
  });

  it.each(group.invalid)('rejects "$input" with $error', ({ input, error }) => {
    expect(parseDecimalToTicks(input, config)).toEqual({
      ok: false,
      error: error as PriceParseError,
    });
  });
});

describe('parseDecimalToTicks', () => {
  it('defaults to the NOVA instrument', () => {
    expect(parseDecimalToTicks('142.5')).toEqual({ ok: true, ticks: 14_250 });
  });
});

describe('ticksToDecimalString', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [-5, '-0.05'],
    [-14_250, '-142.50'],
    [Number.MAX_SAFE_INTEGER, '90071992547409.91'],
  ])('%i -> "%s"', (ticks, expected) => {
    expect(ticksToDecimalString(ticks)).toBe(expected);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'throws on %s',
    (ticks) => {
      expect(() => ticksToDecimalString(ticks)).toThrow(RangeError);
    },
  );
});

describe('formatQty', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [999, '999'],
    [1_000, '1,000'],
    [10_000, '10,000'],
    [1_234_567, '1,234,567'],
    [-1_500, '-1,500'],
  ])('%i -> "%s"', (qty, expected) => {
    expect(formatQty(qty)).toBe(expected);
  });

  it('throws on a non-integer', () => {
    expect(() => formatQty(0.5)).toThrow(RangeError);
  });
});

describe('formatMoney', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [14_250, '142.50'],
    [14_250 * 100, '14,250.00'],
    [100_000_000 * 10_000, '10,000,000,000.00'],
    [-150, '-1.50'],
    [-123_456_789, '-1,234,567.89'],
  ])('%i -> "%s"', (amount, expected) => {
    expect(formatMoney(amount)).toBe(expected);
  });

  it('respects priceDecimals', () => {
    expect(formatMoney(1_234_567, { priceDecimals: 0 })).toBe('1,234,567');
    expect(formatMoney(1_234_567, { priceDecimals: 3 })).toBe('1,234.567');
  });

  it('throws on a non-integer', () => {
    expect(() => formatMoney(1.5)).toThrow(RangeError);
  });
});
