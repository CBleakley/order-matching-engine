// The single tradable instrument, defined once in protocol/instrument.json and
// validated here at import time. The C++ engine service applies the same rules
// (engine-service/Instrument.h); protocol/fixtures/instrument-configs.json keeps
// the two in step.
import rawInstrument from '@ome/protocol/instrument.json' with { type: 'json' };
import { z } from 'zod';

export const MAX_PRICE_DECIMALS = 8;

// The tick size that matches a number of decimals: "1", "0.1", "0.01", ...
export function tickSizeForDecimals(decimals: number): string {
  return decimals === 0 ? '1' : `0.${'0'.repeat(decimals - 1)}1`;
}

// The instrument's fields, also used for the instrument in the public `welcome` message.
export const instrumentFields = {
  symbol: z.string().regex(/^[A-Z0-9]{1,16}$/, 'must be 1-16 characters A-Z or 0-9'),
  name: z.string().min(1),
  // A string, so the source of truth never passes through binary floating point.
  tickSize: z.string(),
  priceDecimals: z.int().min(0).max(MAX_PRICE_DECIMALS),
  minPriceTicks: z.int().min(1),
  maxPriceTicks: z.int(),
  maxOrderQty: z.int().min(1),
  referencePriceTicks: z.int(),
};

const instrumentSchema = z.strictObject(instrumentFields).superRefine((config, ctx) => {
  // Zod still runs this refinement when a field check above has failed (e.g.
  // priceDecimals -1); those failures are already reported, so stop here.
  const integers = [
    config.priceDecimals,
    config.minPriceTicks,
    config.maxPriceTicks,
    config.maxOrderQty,
    config.referencePriceTicks,
  ];
  if (
    !integers.every((value) => Number.isSafeInteger(value)) ||
    config.priceDecimals < 0 ||
    config.priceDecimals > MAX_PRICE_DECIMALS
  ) {
    return;
  }
  const expectedTickSize = tickSizeForDecimals(config.priceDecimals);
  if (config.tickSize !== expectedTickSize) {
    ctx.addIssue({
      code: 'custom',
      path: ['tickSize'],
      message: `must be "${expectedTickSize}" to agree with priceDecimals ${String(config.priceDecimals)}`,
    });
  }
  if (config.minPriceTicks > config.maxPriceTicks) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxPriceTicks'],
      message: 'must be at least minPriceTicks',
    });
  }
  if (
    config.referencePriceTicks < config.minPriceTicks ||
    config.referencePriceTicks > config.maxPriceTicks
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['referencePriceTicks'],
      message: 'must be between minPriceTicks and maxPriceTicks',
    });
  }
  // The largest notional (price in ticks times quantity) must be an exact JS number.
  if (BigInt(config.maxPriceTicks) * BigInt(config.maxOrderQty) > BigInt(Number.MAX_SAFE_INTEGER)) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxOrderQty'],
      message: 'maxPriceTicks * maxOrderQty must not exceed 2^53 - 1',
    });
  }
});

export type InstrumentConfig = Readonly<z.infer<typeof instrumentSchema>>;

export class InstrumentConfigError extends Error {
  override name = 'InstrumentConfigError';
}

// Validates an instrument config, throwing InstrumentConfigError listing every problem.
export function parseInstrumentConfig(raw: unknown): InstrumentConfig {
  const result = instrumentSchema.safeParse(raw);
  if (!result.success) {
    throw new InstrumentConfigError(`Invalid instrument config:\n${z.prettifyError(result.error)}`);
  }
  return Object.freeze(result.data);
}

// The instrument from protocol/instrument.json. Importing this module fails if the file is invalid.
export const INSTRUMENT: InstrumentConfig = parseInstrumentConfig(rawInstrument);
