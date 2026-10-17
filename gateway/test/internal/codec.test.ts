import { describe, expect, it } from 'vitest';

import {
  encodeEngineMessage,
  encodeGatewayMessage,
  engineMessageCodec,
  gatewayMessageCodec,
} from '../../src/internal/codec.js';
import { decodeFrame } from '../../src/internal/frame-decoder.js';
import {
  ENGINE_MESSAGE_LAYOUTS,
  FRAME_HEADER_SIZE,
  GATEWAY_MESSAGE_LAYOUTS,
  REJECT_REASON_CODES,
  type EngineMessage,
  type GatewayMessage,
  type RejectReason,
} from '../../src/internal/protocol.js';
import { ENGINE_FIXTURES, GATEWAY_FIXTURES, readHex } from './fixtures.js';

describe('gateway -> engine messages match the shared fixtures', () => {
  it('covers every message type', () => {
    expect(GATEWAY_FIXTURES.map((f) => f.message.type).sort()).toEqual(
      Object.keys(GATEWAY_MESSAGE_LAYOUTS).sort(),
    );
  });

  it.each(GATEWAY_FIXTURES)('$name', ({ name, message }) => {
    const bytes = readHex(name);
    expect(encodeGatewayMessage(message)).toEqual(bytes);
    expect(bytes.length).toBe(
      FRAME_HEADER_SIZE + (gatewayMessageCodec.payloadSize(bytes[4] ?? -1) ?? -1),
    );
    expect(decodeFrame(gatewayMessageCodec, bytes)).toEqual({ kind: 'message', message });
  });
});

describe('engine -> gateway messages match the shared fixtures', () => {
  it('covers every message type', () => {
    expect(ENGINE_FIXTURES.map((f) => f.message.type).sort()).toEqual(
      Object.keys(ENGINE_MESSAGE_LAYOUTS).sort(),
    );
  });

  it.each(ENGINE_FIXTURES)('$name', ({ name, message }) => {
    const bytes = readHex(name);
    expect(encodeEngineMessage(message)).toEqual(bytes);
    expect(bytes.length).toBe(
      FRAME_HEADER_SIZE + (engineMessageCodec.payloadSize(bytes[4] ?? -1) ?? -1),
    );
    expect(decodeFrame(engineMessageCodec, bytes)).toEqual({ kind: 'message', message });
  });
});

describe('payload sizes', () => {
  it.each([
    [0x01, 2],
    [0x02, 29],
    [0x03, 20],
    [0x04, 0],
  ])('gateway type 0x%s has a %i-byte payload', (code, size) => {
    expect(gatewayMessageCodec.payloadSize(code)).toBe(size);
  });

  it.each([
    [0x81, 18],
    [0x82, 8],
    [0x83, 8],
    [0x84, 45],
    [0x85, 57],
    [0x86, 57],
    [0x87, 53],
    [0x88, 37],
    [0x89, 45],
    [0x8a, 36],
    [0x8b, 8],
  ])('engine type 0x%s has a %i-byte payload', (code, size) => {
    expect(engineMessageCodec.payloadSize(code)).toBe(size);
  });

  it('does not know the other direction’s types', () => {
    expect(gatewayMessageCodec.payloadSize(0x81)).toBeUndefined();
    expect(engineMessageCodec.payloadSize(0x01)).toBeUndefined();
  });
});

describe('reject reasons', () => {
  it.each(Object.keys(REJECT_REASON_CODES) as RejectReason[])('%s round-trips', (reason) => {
    const message: EngineMessage = {
      type: 'orderRejected',
      eventSeq: 1n,
      ts: 2n,
      clientTag: 3n,
      orderId: 0n,
      traderId: 4,
      reason,
    };
    expect(decodeFrame(engineMessageCodec, encodeEngineMessage(message))).toEqual({
      kind: 'message',
      message,
    });
  });
});

describe('encoder range checks', () => {
  const submit = {
    type: 'submitOrder',
    clientTag: 1n,
    traderId: 1,
    side: 'buy',
    price: 1n,
    qty: 1n,
  } as const satisfies GatewayMessage;

  it.each([
    ['clientTag above u64', { clientTag: 1n << 64n }],
    ['negative clientTag', { clientTag: -1n }],
    ['traderId above u32', { traderId: 0x1_0000_0000 }],
    ['negative traderId', { traderId: -1 }],
    ['fractional traderId', { traderId: 1.5 }],
    ['price above i64', { price: 1n << 63n }],
    ['price below i64', { price: -(1n << 63n) - 1n }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => encodeGatewayMessage({ ...submit, ...overrides })).toThrow(RangeError);
  });

  it('rejects values of the wrong runtime type or enum', () => {
    // Deliberately bypass the types to simulate bad data from untyped code.
    const bad = [
      { ...submit, side: 'hold' },
      { ...submit, qty: 1 },
      { ...submit, traderId: 1n },
    ] as unknown as GatewayMessage[];
    for (const message of bad) expect(() => encodeGatewayMessage(message)).toThrow(RangeError);
  });

  it('rejects an unknown message type', () => {
    const bad = { type: 'shutdown' } as unknown as GatewayMessage;
    expect(() => encodeGatewayMessage(bad)).toThrow(TypeError);
  });
});

describe('decodeFrame', () => {
  it('rejects messages from the other direction', () => {
    for (const { name } of GATEWAY_FIXTURES) {
      expect(decodeFrame(engineMessageCodec, readHex(name))).toEqual({
        kind: 'error',
        error: 'unknown-type',
      });
    }
    for (const { name } of ENGINE_FIXTURES) {
      expect(decodeFrame(gatewayMessageCodec, readHex(name))).toEqual({
        kind: 'error',
        error: 'unknown-type',
      });
    }
  });

  it('rejects truncated input and trailing bytes', () => {
    const bytes = readHex('submit-order');
    expect(decodeFrame(gatewayMessageCodec, bytes.subarray(0, bytes.length - 1))).toEqual({
      kind: 'error',
      error: 'truncated',
    });
    const longer = new Uint8Array([...bytes, 0]);
    expect(decodeFrame(gatewayMessageCodec, longer)).toEqual({
      kind: 'error',
      error: 'length-mismatch',
    });
    expect(decodeFrame(gatewayMessageCodec, new Uint8Array())).toEqual({
      kind: 'error',
      error: 'truncated',
    });
  });
});
