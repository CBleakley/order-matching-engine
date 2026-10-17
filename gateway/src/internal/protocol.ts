// Message definitions for the private binary protocol between the gateway and
// the engine service. protocol/internal-protocol.md is the specification;
// engine-service/InternalProtocol.h is the C++ side, and both codecs are tested
// against the byte fixtures in protocol/fixtures/internal/.
//
// Each message's fields are listed once, in wire order, in a layout table.
// The TypeScript types, encoding, decoding and payload sizes all derive from it.

export const PROTOCOL_VERSION = 1;

// Largest accepted value of a frame's length field.
export const MAX_FRAME_LENGTH = 256;

// u32 length + u8 type.
export const FRAME_HEADER_SIZE = 5;

export type Side = 'buy' | 'sell';

export const SIDE_CODES = { buy: 0, sell: 1 } as const satisfies Record<Side, number>;

// Codes 0-3 are the engine's own reject reasons; 16 and up are added by the
// engine service.
export const REJECT_REASON_CODES = {
  invalidPrice: 0,
  invalidQuantity: 1,
  duplicateOrderId: 2,
  unknownOrderId: 3,
  notOwner: 16,
  priceOutOfRange: 17,
  qtyOutOfRange: 18,
} as const;

export type RejectReason = keyof typeof REJECT_REASON_CODES;

export type FieldKind = 'u8' | 'u16' | 'u32' | 'u64' | 'i64' | 'side' | 'reason';

export interface FieldValues {
  u8: number;
  u16: number;
  u32: number;
  u64: bigint;
  i64: bigint;
  side: Side;
  reason: RejectReason;
}

export const FIELD_SIZES: Readonly<Record<FieldKind, number>> = {
  u8: 1,
  u16: 2,
  u32: 4,
  u64: 8,
  i64: 8,
  side: 1,
  reason: 1,
};

export interface MessageLayout {
  readonly code: number;
  readonly fields: readonly (readonly [name: string, kind: FieldKind])[];
}

export type LayoutTable = Readonly<Record<string, MessageLayout>>;

// The message union described by a layout table: { type, ...fields }.
export type MessagesOf<L extends LayoutTable> = {
  [T in keyof L & string]: { readonly type: T } & {
    readonly [F in L[T]['fields'][number] as F[0]]: FieldValues[F[1]];
  };
}[keyof L & string];

// Sent by the gateway, decoded by the engine service.
export const GATEWAY_MESSAGE_LAYOUTS = {
  hello: { code: 0x01, fields: [['protocolVersion', 'u16']] },
  submitOrder: {
    code: 0x02,
    fields: [
      ['clientTag', 'u64'],
      ['traderId', 'u32'],
      ['side', 'side'],
      ['price', 'i64'],
      ['qty', 'i64'],
    ],
  },
  cancelOrder: {
    code: 0x03,
    fields: [
      ['clientTag', 'u64'],
      ['traderId', 'u32'],
      ['orderId', 'u64'],
    ],
  },
  heartbeat: { code: 0x04, fields: [] },
} as const satisfies LayoutTable;

const TRADE_FIELDS = [
  ['eventSeq', 'u64'],
  ['ts', 'i64'],
  ['makerOrderId', 'u64'],
  ['takerOrderId', 'u64'],
  ['buyerTraderId', 'u32'],
  ['sellerTraderId', 'u32'],
  ['price', 'i64'],
  ['qty', 'i64'],
  ['aggressorSide', 'side'],
] as const;

// Sent by the engine service, decoded by the gateway.
export const ENGINE_MESSAGE_LAYOUTS = {
  helloAck: {
    code: 0x81,
    fields: [
      ['protocolVersion', 'u16'],
      ['engineInstanceId', 'u64'],
      ['serverTime', 'i64'],
    ],
  },
  snapshotBegin: { code: 0x82, fields: [['eventSeq', 'u64']] },
  snapshotEnd: { code: 0x83, fields: [['eventSeq', 'u64']] },
  restingOrder: {
    code: 0x84,
    fields: [
      ['orderId', 'u64'],
      ['traderId', 'u32'],
      ['side', 'side'],
      ['price', 'i64'],
      ['originalQty', 'i64'],
      ['remainingQty', 'i64'],
      ['acceptedAt', 'i64'],
    ],
  },
  // A retained trade, sent only inside a snapshot, with its original eventSeq and ts.
  tradeReplay: { code: 0x85, fields: TRADE_FIELDS },
  trade: { code: 0x86, fields: TRADE_FIELDS },
  orderAccepted: {
    code: 0x87,
    fields: [
      ['eventSeq', 'u64'],
      ['ts', 'i64'],
      ['clientTag', 'u64'],
      ['orderId', 'u64'],
      ['traderId', 'u32'],
      ['side', 'side'],
      ['price', 'i64'],
      ['qty', 'i64'],
    ],
  },
  orderRejected: {
    code: 0x88,
    fields: [
      ['eventSeq', 'u64'],
      ['ts', 'i64'],
      ['clientTag', 'u64'],
      ['orderId', 'u64'],
      ['traderId', 'u32'],
      ['reason', 'reason'],
    ],
  },
  orderRested: {
    code: 0x89,
    fields: [
      ['eventSeq', 'u64'],
      ['ts', 'i64'],
      ['orderId', 'u64'],
      ['traderId', 'u32'],
      ['side', 'side'],
      ['price', 'i64'],
      ['remainingQty', 'i64'],
    ],
  },
  orderCancelled: {
    code: 0x8a,
    fields: [
      ['eventSeq', 'u64'],
      ['ts', 'i64'],
      ['orderId', 'u64'],
      ['traderId', 'u32'],
      ['cancelledQty', 'i64'],
    ],
  },
  heartbeat: { code: 0x8b, fields: [['serverTime', 'i64']] },
} as const satisfies LayoutTable;

export type GatewayMessage = MessagesOf<typeof GATEWAY_MESSAGE_LAYOUTS>;
export type EngineMessage = MessagesOf<typeof ENGINE_MESSAGE_LAYOUTS>;

export type GatewayMessageOf<T extends GatewayMessage['type']> = Extract<
  GatewayMessage,
  { type: T }
>;
export type EngineMessageOf<T extends EngineMessage['type']> = Extract<EngineMessage, { type: T }>;

// Reasons a byte stream is rejected. Any of them means the connection must close.
export type ProtocolError =
  | 'frame-too-short' // length 0: no room for the type byte
  | 'frame-too-large' // length above MAX_FRAME_LENGTH
  | 'unknown-type' // not a message type the peer sends
  | 'length-mismatch' // length disagrees with the type's fixed payload size
  | 'invalid-enum' // a side or reject reason byte with no defined meaning
  | 'truncated'; // the input ended part way through a frame
