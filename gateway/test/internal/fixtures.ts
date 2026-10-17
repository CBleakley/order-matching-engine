// The messages encoded in protocol/fixtures/internal/*.hex. The C++ tests
// (tests/InternalProtocolFixtures.h) hold the same values; the shared bytes are
// what keep the two codecs in agreement.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import type { EngineMessage, GatewayMessage } from '../../src/internal/protocol.js';

const require = createRequire(import.meta.url);

export interface InternalFixture<M> {
  readonly name: string; // file name without .hex
  readonly message: M;
}

// Reads a .hex fixture: whitespace-separated hex byte pairs, with '#' starting
// a comment that runs to the end of the line.
export function readHex(name: string): Uint8Array {
  const path = require.resolve(`@ome/protocol/fixtures/internal/${name}.hex`);
  const tokens = readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => (line.split('#')[0] ?? '').trim().split(/\s+/))
    .filter((token) => token !== '');
  return Uint8Array.from(tokens, (token) => {
    if (!/^[0-9a-fA-F]{2}$/.test(token)) throw new Error(`Bad hex byte '${token}' in ${path}`);
    return parseInt(token, 16);
  });
}

export function concatenated(fixtures: readonly InternalFixture<unknown>[]): Uint8Array {
  const parts = fixtures.map((fixture) => readHex(fixture.name));
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);
const U32_MAX = 0xffff_ffff;
const TIME = 1_792_252_800_000_000_000n; // ns since the epoch

export const GATEWAY_FIXTURES: readonly InternalFixture<GatewayMessage>[] = [
  { name: 'hello', message: { type: 'hello', protocolVersion: 1 } },
  {
    name: 'submit-order',
    message: {
      type: 'submitOrder',
      clientTag: U64_MAX,
      traderId: 1_000_000,
      side: 'sell',
      price: -14_250n,
      qty: I64_MAX,
    },
  },
  {
    name: 'cancel-order',
    message: { type: 'cancelOrder', clientTag: 42n, traderId: U32_MAX, orderId: U64_MAX },
  },
  { name: 'gateway-heartbeat', message: { type: 'heartbeat' } },
];

export const ENGINE_FIXTURES: readonly InternalFixture<EngineMessage>[] = [
  {
    name: 'hello-ack',
    message: {
      type: 'helloAck',
      protocolVersion: 1,
      engineInstanceId: 0x0123_4567_89ab_cdefn,
      serverTime: TIME + 123_456_789n,
    },
  },
  { name: 'snapshot-begin', message: { type: 'snapshotBegin', eventSeq: 1n } },
  { name: 'snapshot-end', message: { type: 'snapshotEnd', eventSeq: U64_MAX } },
  {
    name: 'resting-order',
    message: {
      type: 'restingOrder',
      orderId: 7n,
      traderId: 1_000_001,
      side: 'buy',
      price: 14_250n,
      originalQty: 100n,
      remainingQty: 40n,
      acceptedAt: -1n,
    },
  },
  {
    name: 'trade-replay',
    message: {
      type: 'tradeReplay',
      eventSeq: 12n,
      ts: TIME,
      makerOrderId: 7n,
      takerOrderId: 9n,
      buyerTraderId: 1_000_001,
      sellerTraderId: 3,
      price: 14_251n,
      qty: 60n,
      aggressorSide: 'sell',
    },
  },
  {
    name: 'trade',
    message: {
      type: 'trade',
      eventSeq: 1n << 63n,
      ts: I64_MAX,
      makerOrderId: U64_MAX,
      takerOrderId: 1n,
      buyerTraderId: U32_MAX,
      sellerTraderId: 0,
      price: I64_MIN,
      qty: 1n,
      aggressorSide: 'buy',
    },
  },
  {
    name: 'order-accepted',
    message: {
      type: 'orderAccepted',
      eventSeq: 2n,
      ts: TIME + 1n,
      clientTag: U64_MAX,
      orderId: 1n,
      traderId: 1_000_000,
      side: 'buy',
      price: 14_250n,
      qty: 10_000n,
    },
  },
  {
    name: 'order-rejected',
    message: {
      type: 'orderRejected',
      eventSeq: 3n,
      ts: TIME + 2n,
      clientTag: 77n,
      orderId: 0n,
      traderId: 1_000_000,
      reason: 'notOwner',
    },
  },
  {
    name: 'order-rested',
    message: {
      type: 'orderRested',
      eventSeq: 4n,
      ts: TIME + 3n,
      orderId: 1n,
      traderId: 999,
      side: 'sell',
      price: -1n,
      remainingQty: I64_MAX,
    },
  },
  {
    name: 'order-cancelled',
    message: {
      type: 'orderCancelled',
      eventSeq: 5n,
      ts: TIME + 4n,
      orderId: 2n,
      traderId: 1_000_002,
      cancelledQty: 25n,
    },
  },
  { name: 'engine-heartbeat', message: { type: 'heartbeat', serverTime: I64_MIN } },
];
