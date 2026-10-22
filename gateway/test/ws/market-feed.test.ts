// Market data fan-out with fake timers: real MarketData, TraderBook, SessionHub,
// ClientConnection and MarketFeed, over a fake socket whose send queue size
// the tests control.
import { EventEmitter } from 'node:events';

import { parseServerMessage, type Interval, type ServerMessage } from '@ome/shared';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import type { LiveEvent, TradeMessage } from '../../src/engine/engine-client.js';
import { MarketData } from '../../src/market/market-data.js';
import type { OrderEntry } from '../../src/orders/order-entry.js';
import { TraderBook } from '../../src/orders/trader-book.js';
import type { SessionService } from '../../src/session/session-service.js';
import { ClientConnection, type ConnectionLimits } from '../../src/ws/client-connection.js';
import { MarketFeed } from '../../src/ws/market-feed.js';
import { SessionHub, type OutgoingMessage } from '../../src/ws/session-hub.js';

const FLUSH_MS = 100;
const MAX_BUFFERED = 1024 * 1024;
const STALL_MS = 5000;
const ALICE = 1_000_001;
const BOB = 1_000_002;
// Simulated traders.
const SIM_A = 1;
const SIM_B = 2;

const LIMITS: ConnectionLimits = {
  authTimeoutMs: 5000,
  pingIntervalMs: 30_000,
  maxViolations: 5,
  maxBufferedBytes: MAX_BUFFERED,
  stallTimeoutMs: STALL_MS,
};

// Just what ClientConnection uses of a ws WebSocket.
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  terminated = false;
  readonly sent: ServerMessage[] = [];

  send(data: string): void {
    const parsed = parseServerMessage(data);
    if (!parsed.ok) throw new Error(`invalid server message: ${parsed.error.detail}`);
    this.sent.push(parsed.message);
  }

  close(): void {
    this.readyState = 3;
  }

  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
  }

  ping(): void {
    // No pong needed: the keepalive interval is longer than any test.
  }

  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  types(from = 0): ServerMessage['type'][] {
    return this.sent.slice(from).map((m) => m.type);
  }

  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
}

const sessions: Pick<SessionService, 'verify'> = {
  verify: (token) => {
    const traderId = Number(token);
    return Number.isInteger(traderId)
      ? {
          ok: true,
          claims: { traderId, name: `T${String(traderId)}`, engineInstanceId: 1n, issuedAt: 0 },
        }
      : { ok: false, reason: 'malformed' };
  },
};

const orderEntry: Pick<OrderEntry, 'placeOrder' | 'cancelOrder' | 'cancelAll'> = {
  placeOrder: () => undefined,
  cancelOrder: () => undefined,
  cancelAll: () => undefined,
};

let marketData: MarketData;
let traderBook: TraderBook;
let hub: SessionHub<ClientConnection>;
let feed: MarketFeed;
let eventSeq: bigint;
let orderId: bigint;

beforeEach(() => {
  vi.useFakeTimers();
  // 1 s into a 15 s bar (and a 1 m bar).
  vi.setSystemTime(new Date('2026-10-22T12:00:01Z'));
  marketData = new MarketData();
  traderBook = new TraderBook();
  hub = new SessionHub<ClientConnection>();
  traderBook.on('private', (traderId, message) => {
    hub.sendToSession(traderId, message);
  });
  feed = new MarketFeed({ hub, marketData, traderBook, flushIntervalMs: FLUSH_MS });
  feed.start();
  eventSeq = 1n;
  orderId = 1n;
});

afterEach(() => {
  feed.stop();
  for (const connection of hub.authenticated()) connection.close(1000, 'done');
  vi.useRealTimers();
});

function snapshot(traderId: number, interval: Interval): OutgoingMessage {
  return {
    type: 'snapshot',
    interval,
    candles: marketData.bars(interval, 300),
    stats: marketData.stats(),
    ...traderBook.view(traderId),
  };
}

// An authenticated connection for the trader; welcome and snapshot already sent.
function connect(traderId: number): { socket: FakeSocket; connection: ClientConnection } {
  const socket = new FakeSocket();
  const connection = new ClientConnection(socket as unknown as WebSocket, '127.0.0.1', {
    sessions,
    orderEntry,
    hub,
    snapshot,
    limits: LIMITS,
    logger: pino({ level: 'silent' }),
    now: Date.now,
  });
  socket.receive({ type: 'auth', token: String(traderId) });
  expect(socket.types()).toEqual(['welcome', 'snapshot']);
  return { socket, connection };
}

function apply(event: LiveEvent): void {
  marketData.applyEvent(event);
  traderBook.applyEvent(event);
}

function trade(price: number, qty: number, buyer = SIM_A, seller = SIM_B): TradeMessage {
  const event: TradeMessage = {
    type: 'trade',
    eventSeq: eventSeq++,
    ts: BigInt(Date.now()) * 1_000_000n,
    makerOrderId: orderId++,
    takerOrderId: orderId++,
    buyerTraderId: buyer,
    sellerTraderId: seller,
    price: BigInt(price),
    qty: BigInt(qty),
    aggressorSide: 'buy',
  };
  apply(event);
  return event;
}

// An order for the trader that rests in full.
function rest(traderId: number, price: number, qty: number): void {
  const id = orderId++;
  const ts = BigInt(Date.now()) * 1_000_000n;
  const common = { traderId, orderId: id, side: 'buy', price: BigInt(price) } as const;
  apply({
    type: 'orderAccepted',
    eventSeq: eventSeq++,
    ts,
    clientTag: 0n,
    qty: BigInt(qty),
    ...common,
  });
  apply({ type: 'orderRested', eventSeq: eventSeq++, ts, remainingQty: BigInt(qty), ...common });
}

function expectContinuousSeq(socket: FakeSocket): void {
  expect(socket.sent.map((m) => m.seq)).toEqual(socket.sent.map((_m, i) => i + 1));
}

describe('MarketFeed coalescing', () => {
  it('sends many trades in one window as one candles and one stats message', () => {
    const { socket } = connect(ALICE);
    for (let i = 0; i < 20; ++i) trade(14_250 + i, 1);
    expect(socket.types(2)).toEqual([]);

    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(2)).toEqual(['candles', 'stats']);
    expect(socket.ofType('candles')[0]).toMatchObject({
      interval: '15s',
      bars: [{ open: 14_250, high: 14_269, low: 14_250, close: 14_269, volume: 20, trades: 20 }],
    });
    expect(socket.ofType('stats')[0]).toMatchObject({ last: 14_269 });

    // Nothing changed since: nothing sent.
    vi.advanceTimersByTime(10 * FLUSH_MS);
    expect(socket.types(2)).toEqual(['candles', 'stats']);
  });

  it('sends only the bars changed since the last flush, oldest first', () => {
    const { socket } = connect(ALICE);
    trade(14_250, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    // Into the next 15 s bar; the first bar is not touched again.
    vi.advanceTimersByTime(15_000);
    trade(14_300, 2);
    trade(14_310, 3);
    vi.advanceTimersByTime(FLUSH_MS);

    const candles = socket.ofType('candles');
    expect(candles).toHaveLength(2);
    expect(candles[1]?.bars).toEqual([
      expect.objectContaining({ open: 14_300, close: 14_310, volume: 5, trades: 2 }),
    ]);
  });

  it('sends one bar per interval change across a bar boundary within a window', () => {
    const { socket } = connect(ALICE);
    vi.setSystemTime(new Date('2026-10-22T12:00:14.950Z'));
    trade(14_250, 1);
    vi.setSystemTime(new Date('2026-10-22T12:00:15.010Z'));
    trade(14_260, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.ofType('candles')[0]?.bars.map((b) => [b.start % 60_000, b.close])).toEqual([
      [0, 14_250],
      [15_000, 14_260],
    ]);
  });

  it('drops pending changes when the market data is rebuilt', () => {
    const { socket } = connect(ALICE);
    trade(14_250, 1);
    marketData.applySnapshot({
      engineInstanceId: 1n,
      restingOrders: [],
      trades: [],
      nextEventSeq: eventSeq,
    });
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(2)).toEqual([]);
  });

  it('sends nothing before auth', () => {
    const socket = new FakeSocket();
    const connection = new ClientConnection(socket as unknown as WebSocket, '127.0.0.1', {
      sessions,
      orderEntry,
      hub,
      snapshot,
      limits: LIMITS,
      logger: pino({ level: 'silent' }),
      now: Date.now,
    });
    trade(14_250, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.sent).toEqual([]);
    connection.close(1000, 'done');
  });
});

describe('MarketFeed interval switching', () => {
  it('answers setInterval with one snapshot on the next flush, then deltas for that interval', () => {
    const { socket } = connect(ALICE);
    trade(14_250, 1);
    socket.receive({ type: 'setInterval', interval: '5m' });
    socket.receive({ type: 'setInterval', interval: '1m' });
    expect(socket.types(2)).toEqual([]);

    vi.advanceTimersByTime(FLUSH_MS);
    // The snapshot carries the trade, so no separate candles or stats.
    expect(socket.types(2)).toEqual(['snapshot']);
    expect(socket.ofType('snapshot')[1]).toMatchObject({
      interval: '1m',
      candles: [expect.objectContaining({ close: 14_250 })],
      stats: expect.objectContaining({ last: 14_250 }) as unknown,
    });

    trade(14_260, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(3)).toEqual(['candles', 'stats']);
    expect(socket.ofType('candles')[0]).toMatchObject({
      interval: '1m',
      bars: [expect.objectContaining({ close: 14_260, trades: 2 })],
    });
  });

  it('gives connections on different intervals their own bars', () => {
    const a = connect(ALICE);
    const b = connect(BOB);
    b.socket.receive({ type: 'setInterval', interval: '5s' });
    vi.advanceTimersByTime(FLUSH_MS);
    trade(14_250, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(a.socket.ofType('candles').map((m) => m.interval)).toEqual(['15s']);
    expect(b.socket.ofType('candles').map((m) => m.interval)).toEqual(['5s']);
  });
});

describe('MarketFeed private updates and position', () => {
  it('sends private updates immediately, outside the flush', () => {
    const { socket } = connect(ALICE);
    rest(ALICE, 14_000, 5);
    expect(socket.types(2)).toEqual(['orderUpdate', 'position']);
    trade(14_000, 2, ALICE, SIM_B);
    expect(socket.types(4)).toEqual(['fill', 'position']);

    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(6)).toEqual(['candles', 'stats', 'position']);
  });

  it('refreshes P&L when the last price moves, only for traders with a position', () => {
    const alice = connect(ALICE);
    const bob = connect(BOB);
    trade(14_000, 3, ALICE, SIM_B);
    vi.advanceTimersByTime(FLUSH_MS);
    const before = alice.socket.sent.length;
    const bobBefore = bob.socket.sent.length;

    trade(14_100, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(alice.socket.types(before)).toEqual(['candles', 'stats', 'position']);
    expect(alice.socket.ofType('position').at(-1)).toMatchObject({
      netQty: 3,
      cashTicks: -42_000,
      pnlAtLastTicks: 300,
    });
    expect(bob.socket.types(bobBefore)).toEqual(['candles', 'stats']);

    // Same price: no refresh.
    trade(14_100, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(alice.socket.types(before + 3)).toEqual(['candles', 'stats']);
  });
});

describe('MarketFeed slow consumers', () => {
  it('skips market data while over the limit, then sends one snapshot instead of the backlog', () => {
    const { socket } = connect(ALICE);
    socket.bufferedAmount = MAX_BUFFERED + 1;
    for (let i = 0; i < 5; ++i) {
      trade(14_250 + i, 1);
      vi.advanceTimersByTime(FLUSH_MS);
    }
    expect(socket.types(2)).toEqual([]);

    // Private updates still go out.
    rest(ALICE, 14_000, 5);
    expect(socket.types(2)).toEqual(['orderUpdate', 'position']);
    socket.receive({ type: 'ping' });
    expect(socket.types(4)).toEqual(['pong']);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(5)).toEqual(['snapshot']);
    expect(socket.ofType('snapshot')[1]).toMatchObject({
      candles: [expect.objectContaining({ close: 14_254, trades: 5 })],
      openOrders: [expect.objectContaining({ priceTicks: 14_000 })],
    });

    // Back to deltas.
    trade(14_300, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(6)).toEqual(['candles', 'stats']);
    expect(socket.terminated).toBe(false);
    expectContinuousSeq(socket);
  });

  it('defers a requested snapshot until the connection drains', () => {
    const { socket } = connect(ALICE);
    socket.bufferedAmount = MAX_BUFFERED + 1;
    socket.receive({ type: 'setInterval', interval: '1m' });
    vi.advanceTimersByTime(10 * FLUSH_MS);
    expect(socket.types(2)).toEqual([]);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(FLUSH_MS);
    expect(socket.types(2)).toEqual(['snapshot']);
    expect(socket.ofType('snapshot')[1]?.interval).toBe('1m');
  });

  it('terminates a connection that stays over the limit', () => {
    const { socket, connection } = connect(ALICE);
    socket.bufferedAmount = MAX_BUFFERED + 1;
    vi.advanceTimersByTime(STALL_MS - FLUSH_MS);
    expect(socket.terminated).toBe(false);
    vi.advanceTimersByTime(2 * FLUSH_MS);
    expect(socket.terminated).toBe(true);
    expect(hub.size).toBe(0);
    expect(connection.traderId).toBeUndefined();
  });

  it('restarts the stall clock when the connection drains in between', () => {
    const { socket } = connect(ALICE);
    socket.bufferedAmount = MAX_BUFFERED + 1;
    vi.advanceTimersByTime(STALL_MS - 5 * FLUSH_MS);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(FLUSH_MS);
    socket.bufferedAmount = MAX_BUFFERED + 1;
    vi.advanceTimersByTime(STALL_MS - 5 * FLUSH_MS);
    expect(socket.terminated).toBe(false);
  });
});

describe('MarketFeed seq', () => {
  it('numbers every message on a connection 1, 2, 3, ... through flushes, private updates and stalls', () => {
    const alice = connect(ALICE);
    const bob = connect(BOB);
    rest(ALICE, 14_000, 5);
    trade(14_000, 2, BOB, ALICE);
    vi.advanceTimersByTime(FLUSH_MS);
    alice.socket.bufferedAmount = MAX_BUFFERED + 1;
    trade(14_050, 1);
    vi.advanceTimersByTime(FLUSH_MS);
    rest(ALICE, 13_900, 1);
    alice.socket.bufferedAmount = 0;
    alice.socket.receive({ type: 'setInterval', interval: '5s' });
    vi.advanceTimersByTime(FLUSH_MS);
    trade(14_060, 1);
    vi.advanceTimersByTime(FLUSH_MS);

    expect(alice.socket.sent.length).toBeGreaterThan(10);
    expectContinuousSeq(alice.socket);
    expectContinuousSeq(bob.socket);
  });
});
