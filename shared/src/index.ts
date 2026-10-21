// Placeholder name used by gateway and web to prove workspace resolution.
export const SHARED_PACKAGE = '@ome/shared';

export {
  MAX_NAME_LENGTH,
  MIN_NAME_LENGTH,
  validateDisplayName,
  type NameValidation,
} from './display-name.js';
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
export {
  candleBarSchema,
  clientMessageSchema,
  ERROR_CODES,
  errorCodeSchema,
  fillSchema,
  INTERVAL_MS,
  INTERVALS,
  intervalSchema,
  MAX_CLIENT_FRAME_BYTES,
  MAX_CLIENT_ORDER_ID_LENGTH,
  MAX_TOKEN_LENGTH,
  orderViewSchema,
  parseClientMessage,
  parseServerMessage,
  positionSchema,
  serverMessageSchema,
  sideSchema,
  statsSchema,
  utf8ByteLength,
  type CandleBar,
  type ClientMessage,
  type ClientMessageOf,
  type ClientMessageType,
  type ErrorCode,
  type Fill,
  type Interval,
  type OrderView,
  type Position,
  type ProtocolParseErrorCode,
  type ProtocolParseResult,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
  type Side,
  type Stats,
} from './protocol.js';
export {
  REJECT_REASON_TEXT,
  REJECT_REASONS,
  rejectReasonSchema,
  type RejectReason,
} from './reject-reasons.js';
export {
  joinErrorResponseSchema,
  joinResponseSchema,
  SESSION_PATH,
  type JoinErrorResponse,
  type JoinResponse,
} from './session-api.js';
