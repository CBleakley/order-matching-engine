// Placeholder name used by gateway and web to prove workspace resolution.
// Public protocol schemas arrive in P1-09.
export const SHARED_PACKAGE = '@ome/shared';

export {
  INSTRUMENT,
  InstrumentConfigError,
  MAX_PRICE_DECIMALS,
  parseInstrumentConfig,
  tickSizeForDecimals,
  type InstrumentConfig,
} from './instrument.js';
export {
  formatMoney,
  formatQty,
  parseDecimalToTicks,
  ticksToDecimalString,
  type PriceParseError,
  type PriceParseResult,
} from './price.js';
