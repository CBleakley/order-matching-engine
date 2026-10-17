import { describe, expect, it } from 'vitest';

import {
  engineMessageDecoder,
  gatewayMessageDecoder,
  type FrameDecoder,
} from '../../src/internal/frame-decoder.js';
import type {
  EngineMessage,
  LayoutTable,
  MessagesOf,
  ProtocolError,
} from '../../src/internal/protocol.js';
import {
  concatenated,
  ENGINE_FIXTURES,
  GATEWAY_FIXTURES,
  readHex,
  type InternalFixture,
} from './fixtures.js';

// Returns every message available now; throws on a protocol error.
function drain<L extends LayoutTable>(decoder: FrameDecoder<L>, out: MessagesOf<L>[]): void {
  for (;;) {
    const result = decoder.next();
    if (result.kind === 'needMore') return;
    if (result.kind === 'error') throw new Error(`unexpected protocol error ${result.error}`);
    out.push(result.message);
  }
}

function decodeInChunks<L extends LayoutTable>(
  decoder: FrameDecoder<L>,
  stream: Uint8Array,
  chunkSize: number,
): MessagesOf<L>[] {
  const messages: MessagesOf<L>[] = [];
  for (let pos = 0; pos < stream.length; pos += chunkSize) {
    decoder.push(stream.subarray(pos, pos + chunkSize));
    drain(decoder, messages);
  }
  expect(decoder.finish()).toBeUndefined();
  return messages;
}

function errorAfterPushing<L extends LayoutTable>(
  decoder: FrameDecoder<L>,
  bytes: readonly number[] | Uint8Array,
): ProtocolError {
  decoder.push(Uint8Array.from(bytes));
  for (;;) {
    const result = decoder.next();
    if (result.kind === 'error') return result.error;
    if (result.kind === 'needMore')
      throw new Error('expected a protocol error, decoder wants more');
  }
}

// A small deterministic generator (mulberry32), so failures reproduce.
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function describeChunking<L extends LayoutTable>(
  name: string,
  fixtures: readonly InternalFixture<MessagesOf<L>>[],
  makeDecoder: () => FrameDecoder<L>,
): void {
  describe(`${name} stream in any chunking`, () => {
    const stream = concatenated(fixtures);
    const expected = fixtures.map((f) => f.message);

    it('decodes in one chunk', () => {
      expect(decodeInChunks(makeDecoder(), stream, stream.length)).toEqual(expected);
    });

    it('decodes one byte at a time', () => {
      expect(decodeInChunks(makeDecoder(), stream, 1)).toEqual(expected);
    });

    it('decodes in 7-byte chunks', () => {
      expect(decodeInChunks(makeDecoder(), stream, 7)).toEqual(expected);
    });

    // Two reads split at every offset, so every frame is split at every
    // position (including inside the length and at the type byte).
    it('decodes when split at every offset', () => {
      for (let split = 0; split <= stream.length; split++) {
        const decoder = makeDecoder();
        const messages: MessagesOf<L>[] = [];
        decoder.push(stream.subarray(0, split));
        drain(decoder, messages);
        decoder.push(stream.subarray(split));
        drain(decoder, messages);
        expect(messages, `split at ${String(split)}`).toEqual(expected);
        expect(decoder.finish()).toBeUndefined();
      }
    });
  });
}

describeChunking('gateway -> engine', GATEWAY_FIXTURES, gatewayMessageDecoder);
describeChunking('engine -> gateway', ENGINE_FIXTURES, engineMessageDecoder);

describe('FrameDecoder', () => {
  it('decodes a long stream pushed in random chunk sizes', () => {
    const once = concatenated(ENGINE_FIXTURES);
    const stream = new Uint8Array(once.length * 20);
    for (let i = 0; i < 20; i++) stream.set(once, i * once.length);
    const expected = Array.from({ length: 20 }, () => ENGINE_FIXTURES.map((f) => f.message)).flat();

    const random = rng(12345);
    const decoder = engineMessageDecoder();
    const messages: EngineMessage[] = [];
    for (let pos = 0; pos < stream.length;) {
      const n = 1 + Math.floor(random() * 200);
      decoder.push(stream.subarray(pos, pos + n));
      drain(decoder, messages);
      pos += n;
    }
    expect(messages).toEqual(expected);
    expect(decoder.finish()).toBeUndefined();
  });

  it('reports a truncated frame from finish()', () => {
    const hello = readHex('hello');
    for (let keep = 1; keep < hello.length; keep++) {
      const decoder = gatewayMessageDecoder();
      decoder.push(hello.subarray(0, keep));
      expect(decoder.next()).toEqual({ kind: 'needMore' });
      expect(decoder.finish()).toBe('truncated');
    }
  });

  it('finishes cleanly with no input', () => {
    const decoder = gatewayMessageDecoder();
    expect(decoder.next()).toEqual({ kind: 'needMore' });
    expect(decoder.finish()).toBeUndefined();
  });

  it('rejects unknown types', () => {
    expect(errorAfterPushing(gatewayMessageDecoder(), [1, 0, 0, 0, 0x00])).toBe('unknown-type');
    expect(errorAfterPushing(gatewayMessageDecoder(), [1, 0, 0, 0, 0x7f])).toBe('unknown-type');
    expect(errorAfterPushing(engineMessageDecoder(), [1, 0, 0, 0, 0xff])).toBe('unknown-type');
    // A valid engine -> gateway frame sent the wrong way.
    expect(errorAfterPushing(gatewayMessageDecoder(), readHex('engine-heartbeat'))).toBe(
      'unknown-type',
    );
  });

  it('detects a length mismatch from the header alone', () => {
    expect(errorAfterPushing(gatewayMessageDecoder(), [4, 0, 0, 0, 0x01])).toBe('length-mismatch');
    expect(errorAfterPushing(gatewayMessageDecoder(), [2, 0, 0, 0, 0x01])).toBe('length-mismatch');
    expect(errorAfterPushing(gatewayMessageDecoder(), [0, 1, 0, 0, 0x04])).toBe('length-mismatch');
  });

  it('rejects a zero length', () => {
    expect(errorAfterPushing(gatewayMessageDecoder(), [0, 0, 0, 0])).toBe('frame-too-short');
  });

  it('rejects an oversized length after four bytes', () => {
    expect(errorAfterPushing(gatewayMessageDecoder(), [1, 1, 0, 0])).toBe('frame-too-large'); // 257
    expect(errorAfterPushing(engineMessageDecoder(), [0xff, 0xff, 0xff, 0xff])).toBe(
      'frame-too-large',
    );
  });

  it('rejects undefined enum values', () => {
    const submit = readHex('submit-order');
    const sideOffset = 5 + 8 + 4;
    expect(submit[sideOffset]).toBe(1); // sell in the fixture
    submit[sideOffset] = 2;
    expect(errorAfterPushing(gatewayMessageDecoder(), submit)).toBe('invalid-enum');

    const rejected = readHex('order-rejected');
    const reasonOffset = 5 + 8 + 8 + 8 + 8 + 4;
    expect(rejected[reasonOffset]).toBe(16); // notOwner in the fixture
    for (const bad of [4, 15, 19, 255]) {
      rejected[reasonOffset] = bad;
      expect(errorAfterPushing(engineMessageDecoder(), rejected)).toBe('invalid-enum');
    }
  });

  it('delivers valid frames that precede an error', () => {
    const decoder = gatewayMessageDecoder();
    decoder.push(readHex('hello'));
    decoder.push(Uint8Array.from([1, 0, 0, 0, 0x99]));
    expect(decoder.next()).toEqual({
      kind: 'message',
      message: { type: 'hello', protocolVersion: 1 },
    });
    expect(decoder.next()).toEqual({ kind: 'error', error: 'unknown-type' });
  });

  it('keeps the first error', () => {
    const decoder = gatewayMessageDecoder();
    decoder.push(Uint8Array.from([0, 0, 0, 0]));
    expect(decoder.next()).toEqual({ kind: 'error', error: 'frame-too-short' });
    decoder.push(readHex('hello'));
    expect(decoder.next()).toEqual({ kind: 'error', error: 'frame-too-short' });
    expect(decoder.error).toBe('frame-too-short');
    expect(decoder.finish()).toBe('frame-too-short');
  });

  it('only ever returns messages, needMore or an error on random bytes', () => {
    const random = rng(2024);
    const byte = () => Math.floor(random() * 256);
    for (let round = 0; round < 500; round++) {
      const decoder = engineMessageDecoder();
      let failed = false;
      for (let chunk = 0; chunk < 20 && !failed; chunk++) {
        const bytes = Uint8Array.from({ length: 1 + Math.floor(random() * 64) }, byte);
        // Keep lengths small and types plausible half the time, so the
        // decoder gets past the header checks.
        if (bytes.length >= 5 && random() < 0.5) {
          bytes.set([Math.floor(random() * 60), 0, 0, 0, 0x81 + Math.floor(random() * 11)]);
        }
        decoder.push(bytes);
        for (;;) {
          const result = decoder.next();
          if (result.kind === 'needMore') break;
          if (result.kind === 'error') {
            failed = true;
            break;
          }
        }
      }
    }
  });
});
