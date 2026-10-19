// The public browser <-> gateway WebSocket protocol: JSON text frames, one
// message per frame, each with a `type`. Prices are integer ticks, quantities
// integers and timestamps milliseconds since the epoch. See shared/PROTOCOL.md.
//
// Unknown fields: client messages are untrusted and use strict objects, so an
// extra key makes the message invalid. Server messages strip unknown keys, so
// an older web build keeps working against a newer gateway.
import { z } from 'zod';

import { instrumentFields } from './instrument.js';
import { rejectReasonSchema } from './reject-reasons.js';

export const MAX_CLIENT_FRAME_BYTES = 4096;
export const MAX_CLIENT_ORDER_ID_LENGTH = 36;
export const MAX_TOKEN_LENGTH = 1024;

export const INTERVALS = ['5s', '15s', '1m', '5m'] as const;

export const INTERVAL_MS: Readonly<Record<Interval, number>> = Object.freeze({
  '5s': 5_000,
  '15s': 15_000,
  '1m': 60_000,
  '5m': 300_000,
});

// z.int() accepts only safe integers, so every number below is exact in JS.
const ticks = z.int();
const positiveInt = z.int().min(1);
const nonNegativeInt = z.int().min(0);
const timestampMs = nonNegativeInt;
// The engine's order IDs are u64 on the internal wire but are assigned from 1
// upwards, so they stay far below 2^53.
const orderId = positiveInt;

export const sideSchema = z.enum(['buy', 'sell']);
export const intervalSchema = z.enum(INTERVALS);
const clientOrderId = z
  .string()
  .regex(
    new RegExp(`^[A-Za-z0-9_-]{1,${String(MAX_CLIENT_ORDER_ID_LENGTH)}}$`),
    `must be 1-${String(MAX_CLIENT_ORDER_ID_LENGTH)} characters A-Z, a-z, 0-9, _ or -`,
  );

export type Side = z.infer<typeof sideSchema>;
export type Interval = z.infer<typeof intervalSchema>;

// ---- Client -> gateway ----------------------------------------------------

// Shape and integer checks only. Instrument limits (quantity, price range,
// price band) are business rules: the gateway answers them with orderReject.
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('auth'), token: z.string().min(1).max(MAX_TOKEN_LENGTH) }),
  z.strictObject({
    type: z.literal('placeOrder'),
    clientOrderId,
    side: sideSchema,
    qty: positiveInt,
    priceTicks: positiveInt,
  }),
  z.strictObject({ type: z.literal('cancelOrder'), orderId }),
  z.strictObject({ type: z.literal('cancelAll') }),
  z.strictObject({ type: z.literal('setInterval'), interval: intervalSchema }),
  z.strictObject({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

// ---- Gateway -> client ----------------------------------------------------

export const candleBarSchema = z.object({
  // Aligned to the interval in UTC.
  start: timestampMs,
  open: ticks,
  high: ticks,
  low: ticks,
  close: ticks,
  volume: nonNegativeInt,
  trades: nonNegativeInt,
});

// Daily (UTC) statistics; null only before the instrument has ever traded.
const statsFields = {
  last: ticks.nullable(),
  open: ticks.nullable(),
  high: ticks.nullable(),
  low: ticks.nullable(),
  change: ticks.nullable(),
};

const orderViewFields = {
  orderId,
  side: sideSchema,
  priceTicks: positiveInt,
  originalQty: positiveInt,
  filledQty: nonNegativeInt,
  remainingQty: nonNegativeInt,
  status: z.enum(['resting', 'filled', 'cancelled']),
  placedAt: timestampMs,
};

const fillFields = {
  orderId,
  side: sideSchema,
  priceTicks: positiveInt,
  qty: positiveInt,
  time: timestampMs,
  liquidity: z.enum(['maker', 'taker']),
};

const positionFields = {
  // Negative when short.
  netQty: z.int(),
  cashTicks: ticks,
  pnlAtLastTicks: ticks,
  fillCount: nonNegativeInt,
  openOrderCount: nonNegativeInt,
};

export const statsSchema = z.object(statsFields);
export const orderViewSchema = z.object(orderViewFields);
export const fillSchema = z.object(fillFields);
export const positionSchema = z.object(positionFields);

export const ERROR_CODES = ['authRequired', 'sessionExpired', 'rateLimited', 'badMessage'] as const;
export const errorCodeSchema = z.enum(ERROR_CODES);

// `seq` starts at 1 and increases by one per message on each connection.
const seq = positiveInt;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    seq,
    you: z.object({ traderId: positiveInt, name: z.string() }),
    instrument: z.object(instrumentFields),
    serverTime: timestampMs,
  }),
  z.object({
    type: z.literal('snapshot'),
    seq,
    interval: intervalSchema,
    candles: z.array(candleBarSchema),
    stats: statsSchema,
    openOrders: z.array(orderViewSchema),
    fills: z.array(fillSchema),
    position: positionSchema,
  }),
  z.object({
    type: z.literal('candles'),
    seq,
    interval: intervalSchema,
    bars: z.array(candleBarSchema),
  }),
  z.object({ type: z.literal('stats'), seq, ...statsFields }),
  z.object({ type: z.literal('orderAck'), seq, clientOrderId, orderId }),
  z
    .object({
      type: z.literal('orderReject'),
      seq,
      // clientOrderId for a rejected placeOrder, orderId for a rejected cancel.
      clientOrderId: clientOrderId.optional(),
      orderId: orderId.optional(),
      reason: rejectReasonSchema,
      message: z.string(),
    })
    .refine((m) => (m.clientOrderId === undefined) !== (m.orderId === undefined), {
      message: 'exactly one of clientOrderId and orderId is required',
    }),
  z.object({ type: z.literal('orderUpdate'), seq, ...orderViewFields }),
  z.object({ type: z.literal('fill'), seq, ...fillFields }),
  z.object({ type: z.literal('position'), seq, ...positionFields }),
  z.object({ type: z.literal('error'), seq, code: errorCodeSchema, message: z.string() }),
  z.object({ type: z.literal('pong'), seq }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
export type ServerMessageType = ServerMessage['type'];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type CandleBar = z.infer<typeof candleBarSchema>;
export type Stats = z.infer<typeof statsSchema>;
export type OrderView = z.infer<typeof orderViewSchema>;
export type Fill = z.infer<typeof fillSchema>;
export type Position = z.infer<typeof positionSchema>;

// ---- Parsing --------------------------------------------------------------

export type ProtocolParseErrorCode = 'tooLarge' | 'invalidJson' | 'invalidMessage';

export type ProtocolParseResult<T> =
  | { readonly ok: true; readonly message: T }
  | {
      readonly ok: false;
      readonly error: { readonly code: ProtocolParseErrorCode; readonly detail: string };
    };

// The UTF-8 encoded length of a string, counting a lone surrogate as the three
// bytes of its U+FFFD replacement. (No TextEncoder: shared targets plain ES2023.)
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function parseFrame<T>(text: string, schema: z.ZodType<T>): ProtocolParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // A fixed detail: JSON.parse's own message can quote the input, which may hold a token.
    return { ok: false, error: { code: 'invalidJson', detail: 'frame is not valid JSON' } };
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    // Zod issue messages describe the expectation, never the offending value.
    return { ok: false, error: { code: 'invalidMessage', detail: z.prettifyError(result.error) } };
  }
  return { ok: true, message: result.data };
}

// Parses one client text frame. Never throws.
export function parseClientMessage(text: string): ProtocolParseResult<ClientMessage> {
  // Each UTF-16 code unit is at most 3 UTF-8 bytes, so short frames skip the count.
  if (text.length * 3 > MAX_CLIENT_FRAME_BYTES && utf8ByteLength(text) > MAX_CLIENT_FRAME_BYTES) {
    return {
      ok: false,
      error: {
        code: 'tooLarge',
        detail: `frame exceeds ${String(MAX_CLIENT_FRAME_BYTES)} bytes`,
      },
    };
  }
  return parseFrame(text, clientMessageSchema);
}

// Parses one server text frame. Never throws. No size cap: snapshots are large.
export function parseServerMessage(text: string): ProtocolParseResult<ServerMessage> {
  return parseFrame(text, serverMessageSchema);
}
