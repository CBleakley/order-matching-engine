// Conversions between decimal price strings and integer ticks, and display
// formatting. Everything is done on digit strings and integers: no floating
// point arithmetic. The C++ engine service implements the same rules
// (engine-service/Price.h), and both are tested against protocol/fixtures/prices.json.
import { INSTRUMENT, type InstrumentConfig } from './instrument.js';

export type PriceParseError = 'empty' | 'invalid-format' | 'too-many-decimals' | 'out-of-range';

export type PriceParseResult =
  | { readonly ok: true; readonly ticks: number }
  | { readonly ok: false; readonly error: PriceParseError };

type PriceConfig = Pick<InstrumentConfig, 'priceDecimals' | 'minPriceTicks' | 'maxPriceTicks'>;

const DECIMAL_PATTERN = /^([0-9]+)(?:\.([0-9]+))?$/;

// Parses a plain decimal such as "142.5" into ticks (14250 with 2 decimals).
// Rejects signs, exponents, whitespace and other non-digits, more decimals than
// the instrument allows, and prices outside [minPriceTicks, maxPriceTicks].
export function parseDecimalToTicks(
  input: string,
  instrument: PriceConfig = INSTRUMENT,
): PriceParseResult {
  if (input === '') return { ok: false, error: 'empty' };
  const match = DECIMAL_PATTERN.exec(input);
  if (match === null) return { ok: false, error: 'invalid-format' };
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  if (fraction.length > instrument.priceDecimals) {
    return { ok: false, error: 'too-many-decimals' };
  }
  // BigInt keeps arbitrarily long inputs exact until the range check.
  const ticks = BigInt(whole + fraction.padEnd(instrument.priceDecimals, '0'));
  if (ticks < BigInt(instrument.minPriceTicks) || ticks > BigInt(instrument.maxPriceTicks)) {
    return { ok: false, error: 'out-of-range' };
  }
  return { ok: true, ticks: Number(ticks) };
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a safe integer, got ${String(value)}`);
  }
}

// Formats ticks as a decimal with exactly priceDecimals places: 14250 -> "142.50".
// Accepts any safe integer, including negatives (for money amounts).
export function ticksToDecimalString(
  ticks: number,
  instrument: Pick<InstrumentConfig, 'priceDecimals'> = INSTRUMENT,
): string {
  assertSafeInteger(ticks, 'ticks');
  return splitDecimal(ticks, instrument.priceDecimals).join('');
}

// Returns [sign, whole digits, ".fraction" or ""].
function splitDecimal(value: number, decimals: number): [string, string, string] {
  const sign = value < 0 ? '-' : '';
  const digits = String(Math.abs(value)).padStart(decimals + 1, '0');
  const split = digits.length - decimals;
  const fraction = decimals === 0 ? '' : `.${digits.slice(split)}`;
  return [sign, digits.slice(0, split), fraction];
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+$)/g, ',');
}

// Formats a quantity for display: 10000 -> "10,000".
export function formatQty(qty: number): string {
  assertSafeInteger(qty, 'qty');
  const sign = qty < 0 ? '-' : '';
  return sign + groupThousands(String(Math.abs(qty)));
}

// Formats a money amount given in ticks (price ticks * quantity) for display:
// 1425000 -> "14,250.00". Negative amounts keep their sign: "-1.50".
export function formatMoney(
  amountTicks: number,
  instrument: Pick<InstrumentConfig, 'priceDecimals'> = INSTRUMENT,
): string {
  assertSafeInteger(amountTicks, 'amountTicks');
  const [sign, whole, fraction] = splitDecimal(amountTicks, instrument.priceDecimals);
  return sign + groupThousands(whole) + fraction;
}
