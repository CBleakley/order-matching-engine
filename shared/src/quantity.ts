// Parses an order quantity typed by a user. The gateway accepts whole numbers
// from 1 to the instrument's maxOrderQty (anything else is answered with
// orderReject qtyOutOfRange); this applies the same rule before sending.
import { INSTRUMENT, type InstrumentConfig } from './instrument.js';

export type QuantityParseError = 'empty' | 'invalid-format' | 'out-of-range';

export type QuantityParseResult =
  | { readonly ok: true; readonly qty: number }
  | { readonly ok: false; readonly error: QuantityParseError };

const DIGITS_PATTERN = /^[0-9]+$/;

// Accepts digits only: no signs, decimals, exponents, separators or whitespace.
export function parseQuantity(
  input: string,
  instrument: Pick<InstrumentConfig, 'maxOrderQty'> = INSTRUMENT,
): QuantityParseResult {
  if (input === '') return { ok: false, error: 'empty' };
  if (!DIGITS_PATTERN.test(input)) return { ok: false, error: 'invalid-format' };
  // BigInt keeps arbitrarily long inputs exact until the range check.
  const qty = BigInt(input);
  if (qty < 1n || qty > BigInt(instrument.maxOrderQty)) {
    return { ok: false, error: 'out-of-range' };
  }
  return { ok: true, qty: Number(qty) };
}
