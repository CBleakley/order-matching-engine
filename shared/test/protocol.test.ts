import { describe, expect, it } from 'vitest';

import { INSTRUMENT } from '../src/instrument.js';
import {
  INTERVAL_MS,
  INTERVALS,
  MAX_CLIENT_FRAME_BYTES,
  parseClientMessage,
  parseServerMessage,
  utf8ByteLength,
  type ClientMessage,
  type ProtocolParseErrorCode,
  type ServerMessage,
} from '../src/protocol.js';

type Json = Record<string, unknown>;

function client(message: unknown) {
  return parseClientMessage(JSON.stringify(message));
}

function server(message: unknown) {
  return parseServerMessage(JSON.stringify(message));
}

function errorCode(result: { ok: boolean; error?: { code: ProtocolParseErrorCode } }) {
  return result.ok ? undefined : result.error?.code;
}

// ---- Client messages --------------------------------------------------------

const validClient: Record<ClientMessage['type'], ClientMessage> = {
  auth: { type: 'auth', token: 'eyJ0cmFkZXJJZCI6MTAwMDAwMH0.c2ln' },
  placeOrder: {
    type: 'placeOrder',
    clientOrderId: '3f2b8c1e-4d5a-4b6c-9e7f-0a1b2c3d4e5f',
    side: 'buy',
    qty: 100,
    priceTicks: 14_250,
  },
  cancelOrder: { type: 'cancelOrder', orderId: 1043 },
  cancelAll: { type: 'cancelAll' },
  setInterval: { type: 'setInterval', interval: '1m' },
  ping: { type: 'ping' },
};

const invalidClient: [string, Json][] = [
  ['an unknown type', { type: 'hello' }],
  ['a missing type', { token: 'abc' }],
  ['auth without a token', { type: 'auth' }],
  ['auth with an empty token', { type: 'auth', token: '' }],
  ['auth with a numeric token', { type: 'auth', token: 42 }],
  ['auth with an oversize token', { type: 'auth', token: 'x'.repeat(1025) }],
  ['placeOrder without a side', { ...validClient.placeOrder, side: undefined }],
  ['placeOrder with side "long"', { ...validClient.placeOrder, side: 'long' }],
  ['placeOrder with a fractional qty', { ...validClient.placeOrder, qty: 1.5 }],
  ['placeOrder with qty 0', { ...validClient.placeOrder, qty: 0 }],
  ['placeOrder with a negative qty', { ...validClient.placeOrder, qty: -5 }],
  ['placeOrder with qty as a string', { ...validClient.placeOrder, qty: '100' }],
  ['placeOrder with an unsafe qty', { ...validClient.placeOrder, qty: 2 ** 53 }],
  ['placeOrder with fractional priceTicks', { ...validClient.placeOrder, priceTicks: 142.5 }],
  ['placeOrder with priceTicks 0', { ...validClient.placeOrder, priceTicks: 0 }],
  ['placeOrder without a clientOrderId', { ...validClient.placeOrder, clientOrderId: undefined }],
  ['placeOrder with an empty clientOrderId', { ...validClient.placeOrder, clientOrderId: '' }],
  [
    'placeOrder with a 37-character clientOrderId',
    { ...validClient.placeOrder, clientOrderId: 'a'.repeat(37) },
  ],
  [
    'placeOrder with a clientOrderId containing spaces',
    { ...validClient.placeOrder, clientOrderId: 'my order' },
  ],
  ['cancelOrder without an orderId', { type: 'cancelOrder' }],
  ['cancelOrder with orderId 0', { type: 'cancelOrder', orderId: 0 }],
  ['cancelOrder with a string orderId', { type: 'cancelOrder', orderId: '1043' }],
  ['setInterval with interval "1h"', { type: 'setInterval', interval: '1h' }],
  ['setInterval without an interval', { type: 'setInterval' }],
];

describe('parseClientMessage', () => {
  it.each(Object.entries(validClient))('accepts a valid %s', (_type, message) => {
    expect(client(message)).toEqual({ ok: true, message });
  });

  it.each(invalidClient)('rejects %s', (_name, message) => {
    expect(errorCode(client(message))).toBe('invalidMessage');
  });

  it.each(Object.entries(validClient))('rejects %s with an extra field', (_type, message) => {
    expect(errorCode(client({ ...message, extra: 1 }))).toBe('invalidMessage');
  });

  it('accepts a 36-character clientOrderId', () => {
    const message = { ...validClient.placeOrder, clientOrderId: 'a'.repeat(36) };
    expect(client(message).ok).toBe(true);
  });

  it('leaves instrument limits to the gateway', () => {
    const message = {
      ...validClient.placeOrder,
      qty: INSTRUMENT.maxOrderQty + 1,
      priceTicks: INSTRUMENT.maxPriceTicks + 1,
    };
    expect(client(message).ok).toBe(true);
  });

  it.each(['', '{', 'not json', '{"type":"ping",}'])('rejects invalid JSON %j', (text) => {
    expect(errorCode(parseClientMessage(text))).toBe('invalidJson');
  });

  it.each(['null', '[]', '"ping"', '42', 'true'])('rejects non-object JSON %s', (text) => {
    expect(errorCode(parseClientMessage(text))).toBe('invalidMessage');
  });

  it('does not echo the frame in errors', () => {
    const secret = 'secret-token-value';
    const badJson = parseClientMessage(`{"type":"auth","token":"${secret}"`);
    const badToken = client({ type: 'auth', token: secret, extra: true });
    const longToken = client({ type: 'auth', token: secret.repeat(100) });
    for (const result of [badJson, badToken, longToken]) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
  });

  describe('frame size', () => {
    // A ping padded with spaces (valid JSON whitespace) to an exact byte length.
    function pingOfBytes(bytes: number, pad = ' '): string {
      const core = '{"type":"ping"}';
      return core + pad.repeat((bytes - core.length) / utf8ByteLength(pad));
    }

    it('accepts a frame of exactly the maximum size', () => {
      const text = pingOfBytes(MAX_CLIENT_FRAME_BYTES);
      expect(utf8ByteLength(text)).toBe(MAX_CLIENT_FRAME_BYTES);
      expect(parseClientMessage(text).ok).toBe(true);
    });

    it('rejects a frame one byte over the maximum', () => {
      expect(errorCode(parseClientMessage(pingOfBytes(MAX_CLIENT_FRAME_BYTES + 1)))).toBe(
        'tooLarge',
      );
    });

    it('counts multi-byte characters as UTF-8 bytes', () => {
      // 1,400 three-byte characters: 1,414 UTF-16 units but over 4,096 bytes.
      const text = JSON.stringify({ type: 'auth', token: '€'.repeat(1_400) });
      expect(text.length).toBeLessThan(MAX_CLIENT_FRAME_BYTES);
      expect(errorCode(parseClientMessage(text))).toBe('tooLarge');
    });
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['€', 3],
    ['😀', 4],
    ['\uD800', 3],
  ])('%j -> %i', (text, expected) => {
    expect(utf8ByteLength(text)).toBe(expected);
  });
});

// ---- Server messages --------------------------------------------------------

const bar = { start: 1_760_000_010_000, open: 14_250, high: 14_260, low: 14_240, close: 14_255 };
const candleBar = { ...bar, volume: 1_200, trades: 14 };
const statsFields = { last: 14_255, open: 14_100, high: 14_300, low: 14_050, change: 155 };
const orderView = {
  orderId: 1043,
  side: 'buy',
  priceTicks: 14_250,
  originalQty: 100,
  filledQty: 40,
  remainingQty: 60,
  status: 'resting',
  placedAt: 1_760_000_000_000,
} as const;
const fill = {
  orderId: 1043,
  side: 'buy',
  priceTicks: 14_251,
  qty: 40,
  time: 1_760_000_000_500,
  liquidity: 'taker',
} as const;
const position = {
  netQty: -40,
  cashTicks: 570_040,
  pnlAtLastTicks: -160,
  fillCount: 1,
  openOrderCount: 1,
};

const validServer: Record<ServerMessage['type'], ServerMessage> = {
  welcome: {
    type: 'welcome',
    seq: 1,
    you: { traderId: 1_000_042, name: 'Ada' },
    instrument: { ...INSTRUMENT },
    serverTime: 1_760_000_000_000,
  },
  snapshot: {
    type: 'snapshot',
    seq: 2,
    interval: '15s',
    candles: [candleBar],
    stats: statsFields,
    openOrders: [orderView],
    fills: [fill],
    position,
  },
  candles: { type: 'candles', seq: 3, interval: '15s', bars: [candleBar] },
  stats: { type: 'stats', seq: 4, ...statsFields },
  orderAck: { type: 'orderAck', seq: 5, clientOrderId: 'abc-1', orderId: 1043 },
  orderReject: {
    type: 'orderReject',
    seq: 6,
    clientOrderId: 'abc-2',
    reason: 'tooManyOpenOrders',
    message: 'Too many open orders (limit 50)',
  },
  orderUpdate: { type: 'orderUpdate', seq: 7, ...orderView },
  fill: { type: 'fill', seq: 8, ...fill },
  position: { type: 'position', seq: 9, ...position },
  error: { type: 'error', seq: 10, code: 'badMessage', message: 'frame is not valid JSON' },
  pong: { type: 'pong', seq: 11 },
};

const invalidServer: [string, Json][] = [
  ['an unknown type', { type: 'trade', seq: 1 }],
  ['a message without seq', { type: 'pong' }],
  ['seq 0', { type: 'pong', seq: 0 }],
  ['a fractional seq', { type: 'pong', seq: 1.5 }],
  ['welcome without you', { ...validServer.welcome, you: undefined }],
  ['welcome with a string traderId', { ...validServer.welcome, you: { traderId: '1', name: 'A' } }],
  ['welcome without an instrument', { ...validServer.welcome, instrument: undefined }],
  [
    'welcome with an invalid instrument',
    { ...validServer.welcome, instrument: { ...INSTRUMENT, priceDecimals: -1 } },
  ],
  ['snapshot with interval "1h"', { ...validServer.snapshot, interval: '1h' }],
  ['snapshot without fills', { ...validServer.snapshot, fills: undefined }],
  ['snapshot with a non-array candles', { ...validServer.snapshot, candles: candleBar }],
  [
    'snapshot with a bar missing volume',
    { ...validServer.snapshot, candles: [{ ...bar, trades: 1 }] },
  ],
  [
    'candles with a fractional close',
    { ...validServer.candles, bars: [{ ...candleBar, close: 142.55 }] },
  ],
  ['stats with a string last', { ...validServer.stats, last: '142.55' }],
  ['stats without change', { ...validServer.stats, change: undefined }],
  ['orderAck without an orderId', { ...validServer.orderAck, orderId: undefined }],
  [
    'orderReject with neither id',
    { ...validServer.orderReject, clientOrderId: undefined, orderId: undefined },
  ],
  ['orderReject with both ids', { ...validServer.orderReject, orderId: 1043 }],
  ['orderReject with an unknown reason', { ...validServer.orderReject, reason: 'tooBig' }],
  ['orderReject without a message', { ...validServer.orderReject, message: undefined }],
  ['orderUpdate with status "open"', { ...validServer.orderUpdate, status: 'open' }],
  ['orderUpdate with a fractional filledQty', { ...validServer.orderUpdate, filledQty: 0.5 }],
  ['fill with liquidity "both"', { ...validServer.fill, liquidity: 'both' }],
  ['fill with qty 0', { ...validServer.fill, qty: 0 }],
  ['position with a negative fillCount', { ...validServer.position, fillCount: -1 }],
  ['position with a fractional cashTicks', { ...validServer.position, cashTicks: 1.5 }],
  ['error with an unknown code', { ...validServer.error, code: 'teapot' }],
];

describe('parseServerMessage', () => {
  it.each(Object.entries(validServer))('accepts a valid %s', (_type, message) => {
    expect(server(message)).toEqual({ ok: true, message });
  });

  it.each(invalidServer)('rejects %s', (_name, message) => {
    expect(errorCode(server(message))).toBe('invalidMessage');
  });

  it.each(Object.entries(validServer))('strips an extra field from %s', (_type, message) => {
    expect(server({ ...message, extra: 1 })).toEqual({ ok: true, message });
  });

  it('strips extra fields from nested objects', () => {
    const message = { ...validServer.snapshot, candles: [{ ...candleBar, vwap: 14_252 }] };
    expect(server(message)).toEqual({ ok: true, message: validServer.snapshot });
  });

  it('accepts null stats before the first trade', () => {
    const empty = { last: null, open: null, high: null, low: null, change: null };
    expect(server({ type: 'stats', seq: 1, ...empty }).ok).toBe(true);
  });

  it('accepts an orderReject for a cancel, identified by orderId', () => {
    const message = {
      type: 'orderReject',
      seq: 1,
      orderId: 1043,
      reason: 'notOwner',
      message: 'You can only cancel your own orders',
    };
    expect(server(message)).toEqual({ ok: true, message });
  });

  it('has no frame size cap', () => {
    const candles = Array.from({ length: 1_000 }, (_, i) => ({
      ...candleBar,
      start: candleBar.start + i * 15_000,
    }));
    const message = { ...validServer.snapshot, candles };
    expect(JSON.stringify(message).length).toBeGreaterThan(MAX_CLIENT_FRAME_BYTES);
    expect(server(message).ok).toBe(true);
  });

  it.each(['', '{"type":"pong"', 'pong'])('rejects invalid JSON %j', (text) => {
    expect(errorCode(parseServerMessage(text))).toBe('invalidJson');
  });
});

describe('INTERVAL_MS', () => {
  it('has a duration for every interval', () => {
    expect(Object.keys(INTERVAL_MS)).toEqual([...INTERVALS]);
    expect(INTERVAL_MS).toEqual({ '5s': 5_000, '15s': 15_000, '1m': 60_000, '5m': 300_000 });
  });
});
