// Streaming decoder for the internal protocol. Bytes arrive in arbitrary
// chunks (a frame split across reads, or several frames in one read); push()
// buffers them and next() returns complete messages one at a time. Mirrors
// engine-service/FrameDecoder.h.
//
// The first protocol error is sticky: the decoder returns it from then on and
// ignores further input, since the connection must be closed.
import { engineMessageCodec, gatewayMessageCodec, type MessageCodec } from './codec.js';
import {
  FRAME_HEADER_SIZE,
  MAX_FRAME_LENGTH,
  type ENGINE_MESSAGE_LAYOUTS,
  type GATEWAY_MESSAGE_LAYOUTS,
  type LayoutTable,
  type MessagesOf,
  type ProtocolError,
} from './protocol.js';

export type DecodeResult<M> =
  | { readonly kind: 'message'; readonly message: M }
  | { readonly kind: 'needMore' }
  | { readonly kind: 'error'; readonly error: ProtocolError };

const NEED_MORE = { kind: 'needMore' } as const;

export class FrameDecoder<L extends LayoutTable> {
  readonly #codec: MessageCodec<L>;
  #buffer = new Uint8Array(1024);
  #start = 0; // first unconsumed byte
  #end = 0; // one past the last buffered byte
  #error: ProtocolError | undefined;

  constructor(codec: MessageCodec<L>) {
    this.#codec = codec;
  }

  push(chunk: Uint8Array): void {
    if (this.#error !== undefined) return;
    const pending = this.#end - this.#start;
    const needed = pending + chunk.length;
    if (needed > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(needed, this.#buffer.length * 2));
      grown.set(this.#buffer.subarray(this.#start, this.#end));
      this.#buffer = grown;
    } else if (this.#start > 0) {
      this.#buffer.copyWithin(0, this.#start, this.#end);
    }
    this.#start = 0;
    this.#end = pending;
    this.#buffer.set(chunk, this.#end);
    this.#end += chunk.length;
  }

  // The next complete message, needMore, or the protocol error. Header
  // problems are reported as soon as the header bytes arrive, without waiting
  // for the rest of the frame.
  next(): DecodeResult<MessagesOf<L>> {
    if (this.#error !== undefined) return { kind: 'error', error: this.#error };
    const available = this.#end - this.#start;
    if (available < 4) return NEED_MORE;

    const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + this.#start);
    const length = view.getUint32(0, true);
    if (length === 0) return this.#fail('frame-too-short');
    if (length > MAX_FRAME_LENGTH) return this.#fail('frame-too-large');
    if (available < FRAME_HEADER_SIZE) return NEED_MORE;

    const code = view.getUint8(4);
    const size = this.#codec.payloadSize(code);
    if (size === undefined) return this.#fail('unknown-type');
    if (length !== 1 + size) return this.#fail('length-mismatch');
    if (available < 4 + length) return NEED_MORE;

    const message = this.#codec.decodePayload(code, view, FRAME_HEADER_SIZE);
    if (message === undefined) return this.#fail('invalid-enum');
    this.#start += 4 + length;
    return { kind: 'message', message };
  }

  // True if bytes are buffered that next() has not consumed.
  hasBufferedBytes(): boolean {
    return this.#start < this.#end;
  }

  // Call when the input has ended: reports truncated if a frame was cut
  // short, or the earlier error if there was one.
  finish(): ProtocolError | undefined {
    if (this.#error === undefined && this.hasBufferedBytes()) this.#error = 'truncated';
    return this.#error;
  }

  get error(): ProtocolError | undefined {
    return this.#error;
  }

  #fail(error: ProtocolError): DecodeResult<never> {
    this.#error = error;
    return { kind: 'error', error };
  }
}

// Decodes messages sent by the gateway (what the engine service receives).
export function gatewayMessageDecoder(): FrameDecoder<typeof GATEWAY_MESSAGE_LAYOUTS> {
  return new FrameDecoder(gatewayMessageCodec);
}

// Decodes messages sent by the engine service (what the gateway receives).
export function engineMessageDecoder(): FrameDecoder<typeof ENGINE_MESSAGE_LAYOUTS> {
  return new FrameDecoder(engineMessageCodec);
}

// Decodes a buffer that must hold exactly one frame.
export function decodeFrame<L extends LayoutTable>(
  codec: MessageCodec<L>,
  bytes: Uint8Array,
):
  | { readonly kind: 'message'; readonly message: MessagesOf<L> }
  | { readonly kind: 'error'; readonly error: ProtocolError } {
  const decoder = new FrameDecoder(codec);
  decoder.push(bytes);
  const result = decoder.next();
  if (result.kind === 'needMore') return { kind: 'error', error: 'truncated' };
  if (result.kind === 'message' && decoder.hasBufferedBytes()) {
    return { kind: 'error', error: 'length-mismatch' };
  }
  return result;
}
