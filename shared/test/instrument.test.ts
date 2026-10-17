import rawInstrument from '@ome/protocol/instrument.json' with { type: 'json' };
import configFixture from '@ome/protocol/fixtures/instrument-configs.json' with { type: 'json' };
import { describe, expect, it } from 'vitest';

import {
  INSTRUMENT,
  InstrumentConfigError,
  parseInstrumentConfig,
  tickSizeForDecimals,
} from '../src/instrument.js';

describe('INSTRUMENT', () => {
  it('is loaded from protocol/instrument.json', () => {
    expect(INSTRUMENT).toEqual({
      symbol: 'NOVA',
      name: 'Nova Dynamics',
      tickSize: '0.01',
      priceDecimals: 2,
      minPriceTicks: 1,
      maxPriceTicks: 100_000_000,
      maxOrderQty: 10_000,
      referencePriceTicks: 14_250,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(INSTRUMENT)).toBe(true);
  });
});

describe('parseInstrumentConfig', () => {
  it('accepts the checked-in config', () => {
    expect(parseInstrumentConfig(rawInstrument)).toEqual(INSTRUMENT);
  });

  it.each([
    ['whole-unit ticks', { priceDecimals: 0, tickSize: '1' }],
    ['8 decimals', { priceDecimals: 8, tickSize: '0.00000001' }],
    ['a single valid price', { minPriceTicks: 5, maxPriceTicks: 5, referencePriceTicks: 5 }],
    ['notional exactly 2^53 - 1', { maxPriceTicks: Number.MAX_SAFE_INTEGER, maxOrderQty: 1 }],
  ])('accepts %s', (_name, overrides) => {
    expect(() => parseInstrumentConfig({ ...rawInstrument, ...overrides })).not.toThrow();
  });

  describe('rejects the shared invalid fixtures', () => {
    it.each(configFixture.invalid.map((c) => [c.description, c.config] as const))(
      '%s',
      (_description, config) => {
        expect(() => parseInstrumentConfig(config)).toThrow(InstrumentConfigError);
      },
    );
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'NOVA'],
    ['an empty object', {}],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseInstrumentConfig(raw)).toThrow(InstrumentConfigError);
  });

  it('names the offending field in the error message', () => {
    expect(() => parseInstrumentConfig({ ...rawInstrument, tickSize: '0.1' })).toThrow(/tickSize/);
  });
});

describe('tickSizeForDecimals', () => {
  it.each([
    [0, '1'],
    [1, '0.1'],
    [2, '0.01'],
    [8, '0.00000001'],
  ])('%i decimals -> %s', (decimals, expected) => {
    expect(tickSizeForDecimals(decimals)).toBe(expected);
  });
});
