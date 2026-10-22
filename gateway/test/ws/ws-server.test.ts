// The /ws endpoint end to end: real WebSocket clients, the real EngineClient
// and order entry, and the fake engine service.
import type { AddressInfo } from 'node:net';

import { INSTRUMENT, parseServerMessage, type ServerMessage } from '@ome/shared';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { EngineClient } from '../../src/engine/engine-client.js';
import { MarketData } from '../../src/market/market-data.js';
import { OrderEntry } from '../../src/orders/order-entry.js';
import { TraderBook } from '../../src/orders/trader-book.js';
import { buildServer, type GatewayServer } from '../../src/server.js';
import { SessionService } from '../../src/session/session-service.js';
import { signToken } from '../../src/session/token.js';
import { TokenBucketLimiter } from '../../src/session/token-bucket.js';
import { TraderIdRegistry } from '../../src/session/trader-ids.js';
import type { ClientConnection } from '../../src/ws/client-connection.js';
import { SessionHub } from '../../src/ws/session-hub.js';
import type { WebSocketLimits } from '../../src/ws/ws-server.js';
import { FakeEngine } from '../engine/fake-engine.js';

const SECRET = 'a-very-long-session-secret-of-40-chars!!';
const ORIGIN = 'http://localhost:5173';
const MAX_AGE_MS = 60_000;

interface Options {
  readonly ws?: Partial<WebSocketLimits>;
  readonly orderBurst?: number;
  readonly maxOpenOrders?: number;
  readonly trades?: FakeEngine['snapshot']['trades'];
}

interface Harness {
  readonly engine: FakeEngine;
  readonly engineClient: EngineClient;
  readonly server: GatewayServer;
  readonly hub: SessionHub<ClientConnection>;
  readonly sessions: SessionService;
  readonly url: string;
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await delay(5);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function harness(options: Options = {}): Promise<Harness> {
  const engine = await FakeEngine.start();
  if (options.trades !== undefined) engine.snapshot.trades = options.trades;
  cleanup.push(() => engine.close());

  const logger = pino({ level: 'silent' });
  const engineClient = new EngineClient({
    host: '127.0.0.1',
    port: engine.port,
    logger,
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 500,
    requestTimeoutMs: 500,
    reconnect: { initialMs: 10, maxMs: 50 },
  });
  cleanup.push(() => engineClient.stop());

  const traderIds = new TraderIdRegistry();
  const marketData = new MarketData();
  const traderBook = new TraderBook();
  engineClient.on('snapshot', (snapshot) => {
    traderIds.addSnapshot(snapshot);
    marketData.applySnapshot(snapshot);
    traderBook.applySnapshot(snapshot);
  });
  engineClient.on('event', (event) => {
    traderIds.addEvent(event);
    marketData.applyEvent(event);
    traderBook.applyEvent(event);
  });
  const sessions = new SessionService({
    secret: SECRET,
    maxAgeMs: MAX_AGE_MS,
    engineStatus: () => engineClient.status,
    traderIds,
  });
  const hub = new SessionHub<ClientConnection>();
  const server = buildServer({
    logger,
    engineStatus: () => engineClient.status,
    ws: {
      sessions,
      orderEntry: new OrderEntry({
        engine: engineClient,
        openOrders: traderBook,
        lastPrice: () => marketData.stats().last,
        limits: { maxOpenOrdersPerSession: options.maxOpenOrders ?? 50, priceBandPercent: 10 },
        limiter: new TokenBucketLimiter({ ratePerSecond: 10, burst: options.orderBurst ?? 100 }),
      }),
      hub,
      engine: engineClient,
      marketData,
      traderBook,
      limits: {
        allowedOrigins: [ORIGIN],
        maxConnections: 500,
        maxConnectionsPerIp: 50,
        maxMessageBytes: 4096,
        authTimeoutMs: 5000,
        pingIntervalMs: 30_000,
        maxViolations: 5,
        maxBufferedBytes: 1024 * 1024,
        stallTimeoutMs: 5000,
        // Market data flushes would interleave with the exact message lists
        // most tests check, so they only run where a test asks for them
        // (market-feed.test.ts covers the flush logic itself).
        flushIntervalMs: 3_600_000,
        ...options.ws,
      },
    },
  });
  cleanup.push(() => server.close());
  await server.listen({ host: '127.0.0.1', port: 0 });
  engineClient.start();
  await until(() => engineClient.status.ready);
  const { port } = server.server.address() as AddressInfo;
  return { engine, engineClient, server, hub, sessions, url: `ws://127.0.0.1:${String(port)}/ws` };
}

function join(h: Harness, name = 'Alice'): { token: string; traderId: number } {
  const result = h.sessions.create(name);
  if (!result.ok) throw new Error('could not create session');
  return result.session;
}

// Messages carrying the session's state, which most tests here are not about.
const STATE_TYPES: ReadonlySet<ServerMessage['type']> = new Set([
  'snapshot',
  'orderUpdate',
  'fill',
  'position',
]);

// A WebSocket client that records every server message (each checked against
// the public schema) and how the connection closed.
class Client {
  readonly socket: WebSocket;
  // Every message.
  readonly all: ServerMessage[] = [];
  // Every message except the STATE_TYPES ones.
  readonly messages: ServerMessage[] = [];
  readonly invalid: string[] = [];
  closeCode: number | undefined;
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;

  constructor(url: string, options: WebSocket.ClientOptions = { origin: ORIGIN }) {
    this.socket = new WebSocket(url, options);
    this.socket.on('message', (data: Buffer) => {
      const parsed = parseServerMessage(data.toString('utf8'));
      if (parsed.ok) {
        this.all.push(parsed.message);
        if (!STATE_TYPES.has(parsed.message.type)) this.messages.push(parsed.message);
      } else {
        this.invalid.push(parsed.error.detail);
      }
    });
    this.socket.on('error', () => {
      // 'close' follows.
    });
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', () => {
        resolve();
      });
      this.socket.once('unexpected-response', (_request, response) => {
        reject(new Error(`HTTP ${String(response.statusCode)}`));
      });
    });
    this.opened.catch(() => {
      // Tests that expect a refusal await `opened` themselves.
    });
    this.closed = new Promise((resolve) => {
      this.socket.once('close', (code) => {
        this.closeCode = code;
        resolve(code);
      });
    });
    cleanup.push(async () => {
      if (this.closeCode === undefined) {
        this.socket.terminate();
        await this.closed;
      }
    });
  }

  send(message: unknown): void {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  ofType<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.all.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  async waitFor(count: number, timeoutMs = 2000): Promise<void> {
    await until(() => this.messages.length >= count, timeoutMs);
  }
}

async function connect(h: Harness, name = 'Alice'): Promise<{ client: Client; traderId: number }> {
  const { token, traderId } = join(h, name);
  return { client: await authed(h, token), traderId };
}

async function authed(h: Harness, token: string): Promise<Client> {
  const client = new Client(h.url);
  await client.opened;
  client.send({ type: 'auth', token });
  await client.waitFor(1);
  return client;
}

let nextClientOrderId = 0;
function placeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  nextClientOrderId += 1;
  return {
    type: 'placeOrder',
    clientOrderId: `order-${String(nextClientOrderId)}`,
    side: 'buy',
    qty: 5,
    priceTicks: INSTRUMENT.referencePriceTicks,
    ...overrides,
  };
}

function rejectReasons(client: Client): string[] {
  return client.ofType('orderReject').map((m) => m.reason);
}

describe('/ws auth', () => {
  it('welcomes a valid token with the trader and the instrument', async () => {
    const h = await harness();
    const { client, traderId } = await connect(h, 'Alice');
    expect(client.messages).toEqual([
      {
        type: 'welcome',
        seq: 1,
        you: { traderId, name: 'Alice' },
        instrument: { ...INSTRUMENT },
        serverTime: expect.any(Number) as number,
      },
    ]);
    expect(h.hub.connectionsOf(traderId)).toHaveLength(1);
  });

  it('numbers server messages from 1 on each connection', async () => {
    const h = await harness();
    const { client } = await connect(h);
    client.send({ type: 'ping' });
    client.send({ type: 'ping' });
    await client.waitFor(3);
    expect(client.all.map((m) => [m.type, m.seq])).toEqual([
      ['welcome', 1],
      ['snapshot', 2],
      ['pong', 3],
      ['pong', 4],
    ]);
  });

  it.each([
    ['a tampered token', (token: string) => `${token.slice(0, -2)}xx`],
    ['garbage', () => 'not-a-token'],
    [
      'an expired token',
      () =>
        signToken(
          {
            traderId: 1_234_567,
            name: 'Old',
            engineInstanceId: 0x1234n,
            issuedAt: Date.now() - 2 * MAX_AGE_MS,
          },
          SECRET,
        ),
    ],
    [
      'a token from another engine instance',
      () =>
        signToken(
          { traderId: 1_234_567, name: 'Old', engineInstanceId: 0x9999n, issuedAt: Date.now() },
          SECRET,
        ),
    ],
  ])('rejects %s with sessionExpired and closes', async (_label, makeToken) => {
    const h = await harness();
    const client = await authed(h, makeToken(join(h).token));
    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([
      expect.objectContaining({ type: 'error', seq: 1, code: 'sessionExpired' }),
    ]);
    expect(h.hub.size).toBe(0);
  });

  it('answers a non-auth first message with authRequired and closes', async () => {
    const h = await harness();
    const client = new Client(h.url);
    await client.opened;
    client.send(placeOrder());
    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([expect.objectContaining({ code: 'authRequired' })]);
    expect(h.engine.messagesOfType('submitOrder')).toHaveLength(0);
  });

  it('answers an invalid first message with badMessage and closes', async () => {
    const h = await harness();
    const client = new Client(h.url);
    await client.opened;
    client.send('{"type":"auth"');
    expect(await client.closed).toBe(1008);
    expect(client.messages).toEqual([expect.objectContaining({ code: 'badMessage' })]);
  });

  it('closes a connection that does not authenticate in time', async () => {
    const h = await harness({ ws: { authTimeoutMs: 100 } });
    const client = new Client(h.url);
    await client.opened;
    const started = Date.now();
    expect(await client.closed).toBe(1008);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(client.messages).toEqual([expect.objectContaining({ code: 'authRequired' })]);
  });

  it('treats a second auth as a bad message', async () => {
    const h = await harness();
    const { token } = join(h);
    const client = await authed(h, token);
    client.send({ type: 'auth', token });
    await client.waitFor(2);
    expect(client.messages[1]).toMatchObject({ type: 'error', code: 'badMessage' });
    expect(client.closeCode).toBeUndefined();
  });

  it('lets one session hold several connections', async () => {
    const h = await harness();
    const { token, traderId } = join(h);
    const tabs = [await authed(h, token), await authed(h, token)];
    expect(h.hub.connectionsOf(traderId)).toHaveLength(2);
    h.hub.sendToSession(traderId, { type: 'pong' });
    await Promise.all(tabs.map((tab) => tab.waitFor(2)));
    for (const tab of tabs) expect(tab.messages[1]).toEqual({ type: 'pong', seq: 3 });
    tabs[0]?.socket.close();
    await until(() => h.hub.connectionsOf(traderId).length === 1);
  });
});

describe('/ws admission', () => {
  it.each([
    ['a disallowed origin', { origin: 'https://evil.example' }],
    ['no origin', {}],
  ])('refuses %s with 403', async (_label, options) => {
    const h = await harness();
    const client = new Client(h.url, options);
    await expect(client.opened).rejects.toThrow('HTTP 403');
    expect(h.hub.size).toBe(0);
  });

  it('caps connections per IP', async () => {
    const h = await harness({ ws: { maxConnectionsPerIp: 2 } });
    for (let i = 0; i < 2; ++i) await new Client(h.url).opened;
    await expect(new Client(h.url).opened).rejects.toThrow('HTTP 429');
  });

  it('caps connections in total', async () => {
    const h = await harness({ ws: { maxConnections: 2 } });
    for (let i = 0; i < 2; ++i) await new Client(h.url).opened;
    await expect(new Client(h.url).opened).rejects.toThrow('HTTP 503');
  });

  it('frees a slot when a connection closes', async () => {
    const h = await harness({ ws: { maxConnectionsPerIp: 1 } });
    const first = new Client(h.url);
    await first.opened;
    first.socket.close();
    await first.closed;
    await until(() => h.hub.size === 0);
    await new Client(h.url).opened;
  });
});

describe('/ws message validation', () => {
  it('closes the connection on an oversize frame', async () => {
    const h = await harness();
    const { client } = await connect(h);
    client.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(5000) }));
    expect(await client.closed).toBe(1009);
  });

  it('answers frames that fail the schema with badMessage and acts on none', async () => {
    const h = await harness({ ws: { maxViolations: 100 } });
    const { client } = await connect(h);
    const bad: unknown[] = [
      'not json',
      '[]',
      '{"type":"placeOrder"',
      { type: 'nope' },
      placeOrder({ extra: true }),
      placeOrder({ qty: 0 }),
      placeOrder({ qty: 1.5 }),
      placeOrder({ qty: '5' }),
      placeOrder({ priceTicks: -1 }),
      placeOrder({ side: 'hold' }),
      placeOrder({ clientOrderId: 'has space' }),
      placeOrder({ clientOrderId: 'x'.repeat(37) }),
      { type: 'cancelOrder', orderId: 0 },
      { type: 'cancelOrder', orderId: 1, traderId: 7 },
      { type: 'cancelAll', all: true },
      { type: 'setInterval', interval: '1h' },
    ];
    for (const frame of bad) client.send(frame);
    client.socket.send(Buffer.from(JSON.stringify(placeOrder())), { binary: true });
    await client.waitFor(1 + bad.length + 1);
    const errors = client.messages.slice(1);
    expect(errors.every((m) => m.type === 'error' && m.code === 'badMessage')).toBe(true);
    expect(client.closeCode).toBeUndefined();
    await delay(50);
    expect(h.engine.messagesOfType('submitOrder')).toHaveLength(0);
    expect(h.engine.messagesOfType('cancelOrder')).toHaveLength(0);
  });

  it('closes after repeated bad messages', async () => {
    const h = await harness({ ws: { maxViolations: 3 } });
    const { client } = await connect(h);
    for (let i = 0; i < 3; ++i) client.send('bad');
    expect(await client.closed).toBe(1008);
    expect(client.ofType('error')).toHaveLength(3);
  });

  it('never echoes the token in an error', async () => {
    const h = await harness();
    const { token } = join(h);
    const client = await authed(h, token);
    client.send({ type: 'auth', token, extra: 1 });
    await client.waitFor(2);
    expect(JSON.stringify(client.messages)).not.toContain(token);
  });
});

describe('/ws keepalive', () => {
  it('answers ping with pong', async () => {
    const h = await harness();
    const { client } = await connect(h);
    client.send({ type: 'ping' });
    await client.waitFor(2);
    expect(client.messages[1]).toEqual({ type: 'pong', seq: 3 });
  });

  it('keeps a responsive connection and closes one that stops answering pings', async () => {
    const h = await harness({ ws: { pingIntervalMs: 40 } });
    const live = new Client(h.url);
    const dead = new Client(h.url, { origin: ORIGIN, autoPong: false });
    await Promise.all([live.opened, dead.opened]);
    await dead.closed;
    expect(dead.closeCode).toBe(1006);
    await delay(150);
    expect(live.closeCode).toBeUndefined();
  });
});

describe('/ws order entry', () => {
  it('forwards a valid order as the session’s trader and acks it', async () => {
    const h = await harness();
    const { client, traderId } = await connect(h);
    const order = placeOrder({ side: 'sell', qty: 7 });
    client.send(order);
    await client.waitFor(2);
    expect(client.messages[1]).toEqual({
      type: 'orderAck',
      // The order's orderUpdate and position may come first.
      seq: expect.any(Number) as number,
      clientOrderId: order.clientOrderId,
      orderId: 1,
    });
    expect(h.engine.messagesOfType('submitOrder')).toEqual([
      expect.objectContaining({
        traderId,
        side: 'sell',
        qty: 7n,
        price: BigInt(INSTRUMENT.referencePriceTicks),
      }),
    ]);
  });

  it('gives each submit a fresh clientTag', async () => {
    const h = await harness();
    const { client } = await connect(h);
    for (let i = 0; i < 3; ++i) client.send(placeOrder());
    await client.waitFor(4);
    const tags = h.engine.messagesOfType('submitOrder').map((m) => m.clientTag);
    expect(new Set(tags).size).toBe(3);
  });

  it('maps an engine reject', async () => {
    const h = await harness();
    h.engine.onSubmit = (message, engine) => {
      engine.reject(message, 'qtyOutOfRange');
    };
    const { client } = await connect(h);
    const order = placeOrder();
    client.send(order);
    await client.waitFor(2);
    expect(client.messages[1]).toMatchObject({
      type: 'orderReject',
      clientOrderId: order.clientOrderId,
      reason: 'qtyOutOfRange',
    });
  });

  it('rate-limits orders per session', async () => {
    const h = await harness({ orderBurst: 3 });
    const { client } = await connect(h);
    for (let i = 0; i < 5; ++i) client.send(placeOrder());
    await client.waitFor(6);
    expect(client.ofType('orderAck')).toHaveLength(3);
    expect(rejectReasons(client)).toEqual(['rateLimited', 'rateLimited']);
    expect(h.engine.messagesOfType('submitOrder')).toHaveLength(3);
  });

  it('shares the rate limit across a session’s connections', async () => {
    const h = await harness({ orderBurst: 2 });
    const { token } = join(h);
    const tabs = [await authed(h, token), await authed(h, token)];
    for (const tab of tabs) {
      tab.send(placeOrder());
      tab.send(placeOrder());
    }
    await Promise.all(tabs.map((tab) => tab.waitFor(3)));
    expect(h.engine.messagesOfType('submitOrder')).toHaveLength(2);
  });

  it('caps open orders per session', async () => {
    const h = await harness({ maxOpenOrders: 2 });
    const { client } = await connect(h);
    for (let i = 0; i < 3; ++i) client.send(placeOrder());
    await client.waitFor(4);
    expect(client.ofType('orderAck')).toHaveLength(2);
    expect(client.ofType('orderReject')).toEqual([
      expect.objectContaining({
        reason: 'tooManyOpenOrders',
        message: 'Too many open orders (limit 2)',
      }),
    ]);
    // Another session is unaffected.
    const bob = await connect(h, 'Bob');
    bob.client.send(placeOrder());
    await bob.client.waitFor(2);
    expect(bob.client.ofType('orderAck')).toHaveLength(1);
  });

  it('rejects prices outside the band around the last trade', async () => {
    const last = 20_000n;
    const h = await harness({
      trades: [
        {
          type: 'tradeReplay',
          eventSeq: 0n,
          ts: BigInt(Date.now()) * 1_000_000n,
          makerOrderId: 100n,
          takerOrderId: 101n,
          buyerTraderId: 1,
          sellerTraderId: 2,
          price: last,
          qty: 1n,
          aggressorSide: 'buy',
        },
      ],
    });
    const { client } = await connect(h);
    client.send(placeOrder({ priceTicks: INSTRUMENT.referencePriceTicks }));
    client.send(placeOrder({ priceTicks: 22_000 }));
    client.send(placeOrder({ priceTicks: 22_001 }));
    await client.waitFor(4);
    expect(rejectReasons(client)).toEqual(['priceBand', 'priceBand']);
    expect(h.engine.messagesOfType('submitOrder').map((m) => m.price)).toEqual([22_000n]);
  });

  it('rejects quantities above maxOrderQty and prices above the instrument range', async () => {
    const h = await harness();
    const { client } = await connect(h);
    client.send(placeOrder({ qty: INSTRUMENT.maxOrderQty + 1 }));
    client.send(placeOrder({ priceTicks: INSTRUMENT.maxPriceTicks + 1 }));
    await client.waitFor(3);
    expect(rejectReasons(client)).toEqual(['qtyOutOfRange', 'priceOutOfRange']);
    expect(h.engine.messagesOfType('submitOrder')).toHaveLength(0);
  });

  it('rejects a clientOrderId that is still in flight', async () => {
    const h = await harness();
    h.engine.onSubmit = () => {
      // Never reply, so the first order stays in flight.
    };
    const { client } = await connect(h);
    client.send(placeOrder({ clientOrderId: 'same' }));
    client.send(placeOrder({ clientOrderId: 'same' }));
    await client.waitFor(2);
    expect(client.messages[1]).toMatchObject({
      type: 'orderReject',
      clientOrderId: 'same',
      reason: 'duplicateClientOrderId',
    });
  });
});

describe('/ws cancellation', () => {
  async function placeResting(client: Client, n: number): Promise<number[]> {
    const before = client.ofType('orderAck').length;
    for (let i = 0; i < n; ++i) client.send(placeOrder());
    await until(() => client.ofType('orderAck').length === before + n);
    return client
      .ofType('orderAck')
      .slice(before)
      .map((m) => m.orderId);
  }

  it('forwards a cancel of the session’s own resting order', async () => {
    const h = await harness();
    const { client, traderId } = await connect(h);
    const [orderId] = await placeResting(client, 1);
    // The OrderRested that follows the ack must have been applied.
    await delay(20);
    client.send({ type: 'cancelOrder', orderId });
    await until(() => h.engine.messagesOfType('cancelOrder').length === 1);
    expect(h.engine.messagesOfType('cancelOrder')[0]).toMatchObject({
      traderId,
      orderId: BigInt(orderId ?? 0),
    });
    await delay(50);
    expect(client.ofType('orderReject')).toHaveLength(0);
  });

  it('rejects locally a cancel of another session’s order', async () => {
    const h = await harness();
    const bob = await connect(h, 'Bob');
    const [bobsOrder] = await placeResting(bob.client, 1);
    await delay(20);
    const alice = await connect(h, 'Alice');
    alice.client.send({ type: 'cancelOrder', orderId: bobsOrder });
    alice.client.send({ type: 'cancelOrder', orderId: 999 });
    await alice.client.waitFor(3);
    expect(alice.client.ofType('orderReject')).toEqual([
      expect.objectContaining({ orderId: bobsOrder, reason: 'unknownOrder' }),
      expect.objectContaining({ orderId: 999, reason: 'unknownOrder' }),
    ]);
    expect(h.engine.messagesOfType('cancelOrder')).toHaveLength(0);
  });

  it('cancels all of the session’s resting orders and no one else’s', async () => {
    const h = await harness();
    const bob = await connect(h, 'Bob');
    await placeResting(bob.client, 1);
    const alice = await connect(h, 'Alice');
    const mine = await placeResting(alice.client, 3);
    await delay(20);
    alice.client.send({ type: 'cancelAll' });
    await until(() => h.engine.messagesOfType('cancelOrder').length === 3);
    expect(h.engine.messagesOfType('cancelOrder').map((m) => Number(m.orderId))).toEqual(mine);
    expect(h.engine.messagesOfType('cancelOrder').every((m) => m.traderId === alice.traderId)).toBe(
      true,
    );
  });

  it('applies the rate limit to cancelAll', async () => {
    const h = await harness({ orderBurst: 4 });
    const { client } = await connect(h);
    const ids = await placeResting(client, 3);
    await delay(20);
    client.send({ type: 'cancelAll' });
    await until(() => client.ofType('orderReject').length === 2);
    expect(client.ofType('orderReject').map((m) => [m.orderId, m.reason])).toEqual([
      [ids[1], 'rateLimited'],
      [ids[2], 'rateLimited'],
    ]);
    expect(h.engine.messagesOfType('cancelOrder')).toHaveLength(1);
  });
});

describe('/ws and the engine connection', () => {
  it('rejects orders and cancels while the engine is disconnected', async () => {
    const h = await harness();
    const { client } = await connect(h);
    h.engine.refuseNext = 1000;
    h.engine.dropConnections();
    await until(() => !h.engineClient.status.ready);
    client.send(placeOrder());
    client.send({ type: 'cancelOrder', orderId: 1 });
    await client.waitFor(3);
    expect(client.ofType('orderReject')).toEqual([
      expect.objectContaining({
        reason: 'engineUnavailable',
        message: 'Trading is temporarily unavailable — try again shortly',
      }),
      expect.objectContaining({ orderId: 1, reason: 'engineUnavailable' }),
    ]);
    expect(h.engine.messagesOfType('submitOrder')).toHaveLength(0);
    // The session itself survives a brief disconnection.
    expect(client.closeCode).toBeUndefined();
  });

  it('expires every client when the engine service restarts', async () => {
    const h = await harness();
    const alice = await connect(h, 'Alice');
    const bob = await connect(h, 'Bob');
    const pending = new Client(h.url);
    await pending.opened;
    h.engine.engineInstanceId = 0x9999n;
    h.engine.dropConnections();
    const codes = await Promise.all([alice.client.closed, bob.client.closed, pending.closed]);
    expect(codes).toEqual([1008, 1008, 1008]);
    for (const client of [alice.client, bob.client, pending]) {
      expect(client.messages.at(-1)).toMatchObject({ type: 'error', code: 'sessionExpired' });
    }
    expect(h.hub.size).toBe(0);
  });
});

describe('/ws shutdown', () => {
  it('closes clients with 1001 when the server closes', async () => {
    const h = await harness();
    const { client } = await connect(h);
    await h.server.close();
    expect(await client.closed).toBe(1001);
  });
});

describe('/ws private state', () => {
  function stateOf(client: Client): ServerMessage[] {
    return client.all.filter((m) => STATE_TYPES.has(m.type) && m.type !== 'snapshot');
  }

  it('sends a snapshot right after welcome', async () => {
    const h = await harness({
      trades: [
        {
          type: 'tradeReplay',
          eventSeq: 0n,
          ts: BigInt(Date.now()) * 1_000_000n,
          makerOrderId: 100n,
          takerOrderId: 101n,
          buyerTraderId: 1,
          sellerTraderId: 2,
          price: 14_250n,
          qty: 3n,
          aggressorSide: 'buy',
        },
      ],
    });
    const { client } = await connect(h);
    await until(() => client.all.length >= 2);
    expect(client.all[1]).toEqual({
      type: 'snapshot',
      seq: 2,
      interval: '15s',
      candles: [expect.objectContaining({ open: 14_250, close: 14_250, volume: 3, trades: 1 })],
      stats: expect.objectContaining({ last: 14_250 }) as unknown,
      openOrders: [],
      fills: [],
      position: { netQty: 0, cashTicks: 0, pnlAtLastTicks: 0, fillCount: 0, openOrderCount: 0 },
    });
  });

  it('pushes order updates, fills and position to every tab of the sessions involved', async () => {
    const h = await harness();
    const alice = join(h, 'Alice');
    const tabs = [await authed(h, alice.token), await authed(h, alice.token)];
    const bob = await connect(h, 'Bob');
    const carol = await connect(h, 'Carol');

    tabs[0]?.send(placeOrder({ side: 'sell', qty: 5 }));
    await until(() => tabs.every((tab) => tab.ofType('position').length === 1));
    await until(() => tabs[0]?.ofType('orderAck').length === 1);
    const alicesOrder = tabs[0]?.ofType('orderAck')[0]?.orderId ?? 0;

    // Bob's buy of 3 fills against Alice's resting sell, leaving nothing to rest.
    h.engine.onSubmit = (message, engine) => {
      const orderId = engine.nextOrderId++;
      const ts = BigInt(Date.now()) * 1_000_000n;
      engine.send({ ...message, type: 'orderAccepted', eventSeq: engine.seq(), ts, orderId });
      engine.send({
        type: 'trade',
        eventSeq: engine.seq(),
        ts,
        makerOrderId: BigInt(alicesOrder),
        takerOrderId: orderId,
        buyerTraderId: message.traderId,
        sellerTraderId: alice.traderId,
        price: message.price,
        qty: message.qty,
        aggressorSide: 'buy',
      });
    };
    const price = INSTRUMENT.referencePriceTicks;
    bob.client.send(placeOrder({ side: 'buy', qty: 3, priceTicks: price }));
    await until(() => bob.client.ofType('position').length === 1);
    await until(() => tabs.every((tab) => tab.ofType('position').length === 2));

    for (const tab of tabs) {
      expect(stateOf(tab)).toEqual([
        expect.objectContaining({ type: 'orderUpdate', status: 'resting', remainingQty: 5 }),
        expect.objectContaining({ type: 'position', openOrderCount: 1 }),
        expect.objectContaining({
          type: 'orderUpdate',
          orderId: alicesOrder,
          status: 'resting',
          filledQty: 3,
          remainingQty: 2,
        }),
        expect.objectContaining({ type: 'fill', side: 'sell', qty: 3, liquidity: 'maker' }),
        expect.objectContaining({ type: 'position', netQty: -3, cashTicks: 3 * price }),
      ]);
    }
    expect(stateOf(bob.client)).toEqual([
      expect.objectContaining({ type: 'orderUpdate', status: 'filled', filledQty: 3 }),
      expect.objectContaining({ type: 'fill', side: 'buy', qty: 3, liquidity: 'taker' }),
      expect.objectContaining({ type: 'position', netQty: 3, cashTicks: -3 * price }),
    ]);
    expect(stateOf(carol.client)).toEqual([]);
    // seq stays continuous through the mix of message kinds.
    for (const client of [...tabs, bob.client]) {
      expect(client.all.map((m) => m.seq)).toEqual(client.all.map((_m, i) => i + 1));
    }
  });

  it('reports a cancel as an orderUpdate', async () => {
    const h = await harness();
    const { client } = await connect(h);
    client.send(placeOrder());
    await until(() => client.ofType('orderUpdate').length === 1);
    await until(() => client.ofType('orderAck').length === 1);
    const orderId = client.ofType('orderAck')[0]?.orderId;
    client.send({ type: 'cancelOrder', orderId });
    await until(() => client.ofType('orderUpdate').length === 2);
    expect(client.ofType('orderUpdate')[1]).toMatchObject({
      orderId,
      status: 'cancelled',
      filledQty: 0,
      remainingQty: 5,
    });
    expect(client.ofType('position').at(-1)).toMatchObject({ openOrderCount: 0 });
  });

  it('sends a fresh snapshot after reconnecting to the same engine', async () => {
    const h = await harness({ ws: { flushIntervalMs: 10 } });
    const { client, traderId } = await connect(h);
    await until(() => client.ofType('snapshot').length === 1);
    // An order that rested while the gateway was disconnected.
    h.engine.snapshot.restingOrders = [
      {
        type: 'restingOrder',
        orderId: 42n,
        traderId,
        side: 'buy',
        price: 14_000n,
        originalQty: 10n,
        remainingQty: 10n,
        acceptedAt: 5_000_000n,
      },
    ];
    h.engine.dropConnections();
    await until(() => client.ofType('snapshot').length === 2);
    expect(client.ofType('snapshot')[1]?.openOrders).toEqual([
      {
        orderId: 42,
        side: 'buy',
        priceTicks: 14_000,
        originalQty: 10,
        filledQty: 0,
        remainingQty: 10,
        status: 'resting',
        placedAt: 5,
      },
    ]);
    expect(client.closeCode).toBeUndefined();
  });
});

describe('/ws market data', () => {
  it('sends live trades as coalesced candles and stats', async () => {
    const h = await harness({ ws: { flushIntervalMs: 20 } });
    const { client } = await connect(h);
    const ts = BigInt(Date.now()) * 1_000_000n;
    for (const [price, qty] of [
      [14_250n, 2n],
      [14_260n, 3n],
    ] as const) {
      h.engine.send({
        type: 'trade',
        eventSeq: h.engine.seq(),
        ts,
        makerOrderId: 1n,
        takerOrderId: 2n,
        buyerTraderId: 1,
        sellerTraderId: 2,
        price,
        qty,
        aggressorSide: 'buy',
      });
    }
    await until(() => client.ofType('stats').length > 0);
    // The engine's two frames can straddle a flush; together they make one bar.
    const bars = client.ofType('candles').flatMap((m) => m.bars);
    expect(client.ofType('candles').every((m) => m.interval === '15s')).toBe(true);
    expect(bars.at(-1)).toMatchObject({ open: 14_250, close: 14_260, volume: 5, trades: 2 });
    expect(client.ofType('stats').at(-1)).toMatchObject({ last: 14_260 });
  });

  it('answers setInterval with a snapshot for the new interval', async () => {
    const h = await harness({ ws: { flushIntervalMs: 20 } });
    const { client } = await connect(h);
    client.send({ type: 'setInterval', interval: '1m' });
    await until(() => client.ofType('snapshot').length === 2);
    expect(client.ofType('snapshot')[1]).toMatchObject({ interval: '1m', seq: 3 });
  });
});
