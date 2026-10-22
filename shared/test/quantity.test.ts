import { describe, expect, it } from 'vitest';

import { INSTRUMENT } from '../src/instrument.js';
import { parseQuantity, type QuantityParseError } from '../src/quantity.js';

describe('parseQuantity', () => {
  it.each([
    ['1', 1],
    ['100', 100],
    ['007', 7],
    [String(INSTRUMENT.maxOrderQty), INSTRUMENT.maxOrderQty],
  ])('parses "%s" as %d', (input, qty) => {
    expect(parseQuantity(input)).toEqual({ ok: true, qty });
  });

  it.each<[string, QuantityParseError]>([
    ['', 'empty'],
    [' 1', 'invalid-format'],
    ['1 ', 'invalid-format'],
    ['+1', 'invalid-format'],
    ['-1', 'invalid-format'],
    ['1.0', 'invalid-format'],
    ['1e3', 'invalid-format'],
    ['1,000', 'invalid-format'],
    ['１', 'invalid-format'],
    ['0', 'out-of-range'],
    ['000', 'out-of-range'],
    [String(INSTRUMENT.maxOrderQty + 1), 'out-of-range'],
    ['9'.repeat(400), 'out-of-range'],
  ])('rejects "%s" with %s', (input, error) => {
    expect(parseQuantity(input)).toEqual({ ok: false, error });
  });

  it('uses the given instrument limit', () => {
    expect(parseQuantity('50', { maxOrderQty: 50 })).toEqual({ ok: true, qty: 50 });
    expect(parseQuantity('51', { maxOrderQty: 50 })).toEqual({ ok: false, error: 'out-of-range' });
  });
});
