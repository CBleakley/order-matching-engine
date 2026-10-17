// Encoding and payload decoding for the internal protocol, driven by the layout
// tables in protocol.ts. All integers are little-endian; 64-bit fields are
// bigints so no precision is lost.
import {
  ENGINE_MESSAGE_LAYOUTS,
  FIELD_SIZES,
  FRAME_HEADER_SIZE,
  GATEWAY_MESSAGE_LAYOUTS,
  REJECT_REASON_CODES,
  SIDE_CODES,
  type EngineMessage,
  type FieldKind,
  type GatewayMessage,
  type LayoutTable,
  type MessageLayout,
  type MessagesOf,
  type RejectReason,
  type Side,
} from './protocol.js';

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const UINT_MAX: Readonly<Partial<Record<FieldKind, number>>> = {
  u8: 0xff,
  u16: 0xffff,
  u32: 0xffff_ffff,
};

const SIDE_BY_CODE = new Map<number, Side>(
  Object.entries(SIDE_CODES).map(([side, code]) => [code, side as Side]),
);
const REASON_BY_CODE = new Map<number, RejectReason>(
  Object.entries(REJECT_REASON_CODES).map(([reason, code]) => [code, reason as RejectReason]),
);

interface Entry {
  readonly type: string;
  readonly layout: MessageLayout;
  readonly payloadSize: number;
}

function writeField(view: DataView, offset: number, kind: FieldKind, value: unknown, name: string) {
  const invalid = () => new RangeError(`${name}: ${String(value)} is not a valid ${kind}`);
  switch (kind) {
    case 'u8':
    case 'u16':
    case 'u32': {
      const max = UINT_MAX[kind] ?? 0;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw invalid();
      }
      if (kind === 'u8') view.setUint8(offset, value);
      else if (kind === 'u16') view.setUint16(offset, value, true);
      else view.setUint32(offset, value, true);
      return;
    }
    // DataView wraps out-of-range bigints silently, so range-check first.
    case 'u64':
      if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) throw invalid();
      view.setBigUint64(offset, value, true);
      return;
    case 'i64':
      if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) throw invalid();
      view.setBigInt64(offset, value, true);
      return;
    case 'side':
      if (typeof value !== 'string' || !Object.hasOwn(SIDE_CODES, value)) throw invalid();
      view.setUint8(offset, SIDE_CODES[value as Side]);
      return;
    case 'reason':
      if (typeof value !== 'string' || !Object.hasOwn(REJECT_REASON_CODES, value)) throw invalid();
      view.setUint8(offset, REJECT_REASON_CODES[value as RejectReason]);
      return;
  }
}

// Returns undefined for an enum byte with no defined meaning.
function readField(view: DataView, offset: number, kind: FieldKind): unknown {
  switch (kind) {
    case 'u8':
      return view.getUint8(offset);
    case 'u16':
      return view.getUint16(offset, true);
    case 'u32':
      return view.getUint32(offset, true);
    case 'u64':
      return view.getBigUint64(offset, true);
    case 'i64':
      return view.getBigInt64(offset, true);
    case 'side':
      return SIDE_BY_CODE.get(view.getUint8(offset));
    case 'reason':
      return REASON_BY_CODE.get(view.getUint8(offset));
  }
}

// Encodes and decodes one direction's message set.
export class MessageCodec<L extends LayoutTable> {
  readonly #byCode = new Map<number, Entry>();
  readonly #byType = new Map<string, Entry>();

  constructor(layouts: L) {
    for (const [type, layout] of Object.entries(layouts)) {
      const payloadSize = layout.fields.reduce((size, [, kind]) => size + FIELD_SIZES[kind], 0);
      const entry = { type, layout, payloadSize };
      this.#byCode.set(layout.code, entry);
      this.#byType.set(type, entry);
    }
  }

  // The payload size for a type byte, or undefined if the type is not in this set.
  payloadSize(code: number): number | undefined {
    return this.#byCode.get(code)?.payloadSize;
  }

  // Returns one complete frame. Throws RangeError if a field is out of range
  // for its wire type.
  encode(message: MessagesOf<L>): Uint8Array<ArrayBuffer> {
    const entry = this.#byType.get(message.type);
    if (entry === undefined) throw new TypeError(`Unknown message type ${message.type}`);
    const bytes = new Uint8Array(FRAME_HEADER_SIZE + entry.payloadSize);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1 + entry.payloadSize, true);
    view.setUint8(4, entry.layout.code);
    // Fields are looked up by the names in the layout, which MessagesOf<L>
    // guarantees are present with the right types.
    const values = message as unknown as Readonly<Record<string, unknown>>;
    let offset = FRAME_HEADER_SIZE;
    for (const [name, kind] of entry.layout.fields) {
      writeField(view, offset, kind, values[name], name);
      offset += FIELD_SIZES[kind];
    }
    return bytes;
  }

  // Decodes a payload whose type and size have already been checked. Returns
  // undefined if an enum field holds an undefined value.
  decodePayload(code: number, view: DataView, offset: number): MessagesOf<L> | undefined {
    const entry = this.#byCode.get(code);
    if (entry === undefined) return undefined;
    const message: Record<string, unknown> = { type: entry.type };
    for (const [name, kind] of entry.layout.fields) {
      const value = readField(view, offset, kind);
      if (value === undefined) return undefined;
      message[name] = value;
      offset += FIELD_SIZES[kind];
    }
    // Built field by field from the layout that defines MessagesOf<L>.
    return message as MessagesOf<L>;
  }
}

export const gatewayMessageCodec = new MessageCodec(GATEWAY_MESSAGE_LAYOUTS);
export const engineMessageCodec = new MessageCodec(ENGINE_MESSAGE_LAYOUTS);

export function encodeGatewayMessage(message: GatewayMessage): Uint8Array<ArrayBuffer> {
  return gatewayMessageCodec.encode(message);
}

export function encodeEngineMessage(message: EngineMessage): Uint8Array<ArrayBuffer> {
  return engineMessageCodec.encode(message);
}
