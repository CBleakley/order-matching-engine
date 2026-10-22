import { INSTRUMENT } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import { estimatedValueTicks, validateOrderForm } from '../src/ticket/order-form.js';

describe('validateOrderForm', () => {
  it('parses a valid quantity and price', () => {
    expect(validateOrderForm('100', '142.5', INSTRUMENT)).toEqual({
      qty: 100,
      priceTicks: 14250,
      qtyError: null,
      priceError: null,
    });
  });

  it('ignores surrounding whitespace', () => {
    expect(validateOrderForm(' 100 ', ' 142.50 ', INSTRUMENT)).toMatchObject({
      qty: 100,
      priceTicks: 14250,
    });
  });

  it.each([
    ['', 'Enter a quantity'],
    ['1.5', 'Quantity must be a whole number'],
    ['-3', 'Quantity must be a whole number'],
    ['abc', 'Quantity must be a whole number'],
    ['0', 'Quantity must be between 1 and 10,000'],
    ['10001', 'Quantity must be between 1 and 10,000'],
  ])('quantity "%s": %s', (input, message) => {
    const result = validateOrderForm(input, '142.50', INSTRUMENT);
    expect(result.qty).toBeNull();
    expect(result.qtyError).toBe(message);
    expect(result.priceError).toBeNull();
  });

  it.each([
    ['', 'Enter a limit price'],
    ['abc', 'Enter a price like 142.50'],
    ['-1', 'Enter a price like 142.50'],
    ['142.505', 'Prices move in steps of 0.01'],
    ['0', 'Price must be between 0.01 and 1,000,000.00'],
    ['1000000.01', 'Price must be between 0.01 and 1,000,000.00'],
  ])('price "%s": %s', (input, message) => {
    const result = validateOrderForm('100', input, INSTRUMENT);
    expect(result.priceTicks).toBeNull();
    expect(result.priceError).toBe(message);
    expect(result.qtyError).toBeNull();
  });

  it('uses the instrument from the gateway', () => {
    const instrument = { ...INSTRUMENT, maxOrderQty: 50, tickSize: '0.1', priceDecimals: 1 };
    expect(validateOrderForm('51', '1.25', instrument)).toMatchObject({
      qtyError: 'Quantity must be between 1 and 50',
      priceError: 'Prices move in steps of 0.1',
    });
  });
});

describe('estimatedValueTicks', () => {
  it('multiplies quantity by price', () => {
    expect(estimatedValueTicks(100, 14250)).toBe(1_425_000);
  });
});
