// Client-side checks on the order ticket's inputs, with the shared parsers the
// gateway's rules are built on: a whole-number quantity up to maxOrderQty and
// a price on the tick grid within the instrument's range. The price band
// around the last trade is gateway configuration, so the gateway checks it.
import {
  formatMoney,
  formatQty,
  type InstrumentConfig,
  parseDecimalToTicks,
  type PriceParseError,
  parseQuantity,
  type QuantityParseError,
  ticksToDecimalString,
} from '@ome/shared';

export type FormInstrument = Pick<
  InstrumentConfig,
  | 'tickSize'
  | 'priceDecimals'
  | 'minPriceTicks'
  | 'maxPriceTicks'
  | 'maxOrderQty'
  | 'referencePriceTicks'
>;

export interface OrderFormResult {
  // Null when the field is invalid; its message is then set.
  readonly qty: number | null;
  readonly priceTicks: number | null;
  readonly qtyError: string | null;
  readonly priceError: string | null;
}

// Surrounding whitespace is ignored; anything else the parsers reject is an error.
export function validateOrderForm(
  qtyText: string,
  priceText: string,
  instrument: FormInstrument,
): OrderFormResult {
  const qty = parseQuantity(qtyText.trim(), instrument);
  const price = parseDecimalToTicks(priceText.trim(), instrument);
  return {
    qty: qty.ok ? qty.qty : null,
    priceTicks: price.ok ? price.ticks : null,
    qtyError: qty.ok ? null : qtyMessage(qty.error, instrument),
    priceError: price.ok ? null : priceMessage(price.error, instrument),
  };
}

function qtyMessage(error: QuantityParseError, instrument: FormInstrument): string {
  switch (error) {
    case 'empty':
      return 'Enter a quantity';
    case 'invalid-format':
      return 'Quantity must be a whole number';
    case 'out-of-range':
      return `Quantity must be between 1 and ${formatQty(instrument.maxOrderQty)}`;
  }
}

function priceMessage(error: PriceParseError, instrument: FormInstrument): string {
  switch (error) {
    case 'empty':
      return 'Enter a limit price';
    case 'invalid-format':
      return `Enter a price like ${ticksToDecimalString(instrument.referencePriceTicks, instrument)}`;
    case 'too-many-decimals':
      return `Prices move in steps of ${instrument.tickSize}`;
    case 'out-of-range':
      return `Price must be between ${formatMoney(instrument.minPriceTicks, instrument)} and ${formatMoney(instrument.maxPriceTicks, instrument)}`;
  }
}

// The order's value in price ticks × quantity. The instrument keeps the
// largest possible value below 2^53.
export function estimatedValueTicks(qty: number, priceTicks: number): number {
  return qty * priceTicks;
}
