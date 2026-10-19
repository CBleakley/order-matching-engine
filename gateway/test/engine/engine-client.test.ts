import { once } from 'node:events';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EngineClient,
  EngineDisconnectedError,
  EngineTimeoutError,
  EngineUnavailableError,
  type EngineClientEvents,
  type EngineClientOptions,
  type LiveEvent,
} from '../../src/engine/engine-client.js';
import type { GatewayMessageOf } from '../../src/internal/protocol.js';
import { FakeEngine } from './fake-engine.js';

// Short real timeouts keep the tests fast; the fake engine heartbeats every
// 20 ms, well inside the client's 200 ms timeout.
const FAST = {
  heartbeatIntervalMs: 20,
  heartbeatTimeoutMs: 200,
  requestTimeoutMs: 200,
  reconnect: { initialMs: 10, maxMs: 50 },
} as const;

const RESTING_ORDER = {
  type: 'restingOrder',
  orderId: 7n,
  traderId: 1_000_000,
  side: 'buy',
  price: 14_250n,
  originalQty: 10n,
  remainingQty: 4n,
  acceptedAt: 1_700_000_000_000_000_000n,
} as const;

const TRADE_REPLAY = {
  type: 'tradeReplay',
  eventSeq: 40n,
  ts: 1_700_000_000_500_000_000n,
  makerOrderId: 7n,
  takerOrderId: 8n,
  buyerTraderId: 1_000_000,
  sellerTraderId: 12,
  price: 14_250n,
  qty: 6n,
  aggressorSide: 'sell',
} as const;

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// once() for the client's typed events.
function next<K extends keyof EngineClientEvents>(
  c: EngineClient,
  event: K,
): Promise<EngineClientEvents[K]> {
  return once(c, event) as Promise<EngineClientEvents[K]>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let engine: FakeEngine;
let client: EngineClient | undefined;

function makeClient(options: Partial<EngineClientOptions> = {}): EngineClient {
  client = new EngineClient({
    host: '127.0.0.1',
    port: engine.port,
    logger: pino({ level: 'silent' }),
    ...FAST,
    ...options,
  });
  return client;
}

// Starts a client and waits for its first snapshot.
async function readyClient(options: Partial<EngineClientOptions> = {}): Promise<EngineClient> {
  const c = makeClient(options);
  const snapshot = next(c, 'snapshot');
  c.start();
  await snapshot;
  return c;
}

function collectEvents(c: EngineClient): LiveEvent[] {
  const events: LiveEvent[] = [];
  c.on('event', (event) => events.push(event));
  return events;
}

beforeEach(async () => {
  engine = await FakeEngine.start();
});

afterEach(async () => {
  await client?.stop();
  client = undefined;
  await engine.close();
});

describe('handshake and snapshot', () => {
  it('sends Hello first and reports the engine instance', async () => {
    const c = makeClient();
    const connected = next(c, 'connected');
    c.start();
    const [info] = await connected;
    expect(info.engineInstanceId).toBe(0x1234n);
    expect(engine.received[0]).toEqual({ type: 'hello', protocolVersion: 1 });
    expect(c.status.connected).toBe(true);
    expect(c.status.engineInstanceId).toBe(0x1234n);
  });

  it('delivers the snapshot, then becomes ready', async () => {
    engine.snapshot = { restingOrders: [RESTING_ORDER], trades: [TRADE_REPLAY] };
    engine.nextEventSeq = 42n;
    const c = makeClient();
    const snapshotEvent = next(c, 'snapshot');
    expect(c.status.ready).toBe(false);
    c.start();
    const [snapshot] = await snapshotEvent;
    expect(snapshot).toEqual({
      engineInstanceId: 0x1234n,
      restingOrders: [RESTING_ORDER],
      trades: [TRADE_REPLAY],
      nextEventSeq: 42n,
    });
    expect(c.status.ready).toBe(true);
  });

  it('delivers live events in order after the snapshot', async () => {
    engine.nextEventSeq = 42n;
    const c = await readyClient();
    const events = collectEvents(c);
    const trade = { ...TRADE_REPLAY, type: 'trade', eventSeq: engine.seq() } as const;
    const rested = {
      type: 'orderRested',
      eventSeq: engine.seq(),
      ts: 1n,
      orderId: 9n,
      traderId: 5,
      side: 'buy',
      price: 14_200n,
      remainingQty: 3n,
    } as const;
    engine.send(trade);
    engine.send(rested);
    await until(() => events.length === 2);
    expect(events).toEqual([trade, rested]);
  });
});

describe('protocol violations', () => {
  async function expectReconnect(c: EngineClient, violate: () => void): Promise<string> {
    const disconnected = next(c, 'disconnected');
    const snapshot = next(c, 'snapshot');
    violate();
    const [info] = await disconnected;
    await snapshot;
    expect(engine.connectionCount).toBe(2);
    return info.reason;
  }

  it('reconnects on a live event before SnapshotEnd', async () => {
    const c = makeClient();
    const connected = next(c, 'connected');
    // Answer Hello with HelloAck and SnapshotBegin, then a Trade.
    engine.silent = true;
    c.start();
    await until(() => engine.connectionCount === 1);
    engine.send({ type: 'helloAck', protocolVersion: 1, engineInstanceId: 1n, serverTime: 0n });
    await connected;
    engine.silent = false;
    const events = collectEvents(c);
    const reason = await expectReconnect(c, () => {
      engine.send({ type: 'snapshotBegin', eventSeq: 1n });
      engine.send({ ...TRADE_REPLAY, type: 'trade', eventSeq: 1n });
    });
    expect(reason).toMatch(/unexpected trade during snapshot/);
    expect(events).toEqual([]);
  });

  it('reconnects on an eventSeq gap', async () => {
    const c = await readyClient();
    const reason = await expectReconnect(c, () => {
      engine.send({ ...TRADE_REPLAY, type: 'trade', eventSeq: engine.nextEventSeq + 1n });
    });
    expect(reason).toMatch(/eventSeq/);
  });

  it('reconnects on undecodable bytes', async () => {
    const c = await readyClient();
    const reason = await expectReconnect(c, () => {
      engine.sendRaw(Uint8Array.from([1, 0, 0, 0, 0x7f]));
    });
    expect(reason).toMatch(/protocol error: unknown-type/);
  });

  it('reconnects on a protocol version mismatch', async () => {
    const c = makeClient();
    const snapshot = next(c, 'snapshot');
    engine.silent = true;
    c.start();
    await until(() => engine.connectionCount === 1);
    engine.send({ type: 'helloAck', protocolVersion: 2, engineInstanceId: 1n, serverTime: 0n });
    engine.silent = false;
    await snapshot;
    expect(engine.connectionCount).toBe(2);
  });
});

describe('heartbeats', () => {
  it('sends heartbeats while connected', async () => {
    await readyClient();
    await until(() => engine.messagesOfType('heartbeat').length >= 3);
  });

  it('drops a silent engine and reconnects', async () => {
    const c = await readyClient();
    const disconnected = next(c, 'disconnected');
    engine.silent = true;
    const started = Date.now();
    const [info] = await disconnected;
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.heartbeatTimeoutMs - 30);
    expect(info.reason).toMatch(/nothing received/);
    expect(c.status).toMatchObject({ connected: false, ready: false });
    engine.silent = false;
    await next(c, 'snapshot');
    expect(engine.connectionCount).toBe(2);
  });

  it('times out a handshake that never completes', async () => {
    engine.silent = true;
    makeClient().start();
    await until(() => engine.connectionCount >= 2);
  });
});

describe('reconnect', () => {
  it('backs off exponentially, and resets after a successful connection', async () => {
    // random ~1 makes every delay its ceiling: 49, 99, 199 ms, then 49 again.
    const reconnect = { initialMs: 50, maxMs: 1000 };
    engine.refuseNext = 3;
    const c = makeClient({ reconnect, random: () => 0.999 });
    const snapshot = next(c, 'snapshot');
    c.start();
    await snapshot;
    const gaps = engine.acceptedAt.slice(1).map((at, i) => at - (engine.acceptedAt[i] ?? at));
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toBeGreaterThanOrEqual(40);
    expect(gaps[1]).toBeGreaterThanOrEqual(90);
    expect(gaps[2]).toBeGreaterThanOrEqual(190);

    const beforeDrop = Date.now();
    engine.dropConnections();
    await next(c, 'snapshot');
    expect(Date.now() - beforeDrop).toBeLessThan(150);
  });

  it('emits engineReset when the engine instance changes', async () => {
    const c = await readyClient();
    const resets: unknown[] = [];
    const order: string[] = [];
    c.on('engineReset', (info) => {
      resets.push(info);
      order.push('engineReset');
    });
    c.on('connected', () => order.push('connected'));

    // Same instance: a plain reconnect.
    engine.dropConnections();
    await next(c, 'snapshot');
    expect(resets).toEqual([]);

    engine.engineInstanceId = 0x9999n;
    engine.dropConnections();
    await next(c, 'snapshot');
    expect(resets).toEqual([{ previousInstanceId: 0x1234n, engineInstanceId: 0x9999n }]);
    expect(order).toEqual(['connected', 'engineReset', 'connected']);
    expect(c.status.engineInstanceId).toBe(0x9999n);
  });

  it('can restart before the stopped connection has closed', async () => {
    const c = await readyClient();
    const stopped = c.stop();
    const snapshot = next(c, 'snapshot');
    c.start();
    await stopped;
    await snapshot;
    expect(c.status).toMatchObject({ connected: true, ready: true });
    await expect(c.submit({ traderId: 1, side: 'buy', price: 1n, qty: 1n })).resolves.toMatchObject(
      { type: 'orderAccepted' },
    );
  });

  it('stops reconnecting after stop()', async () => {
    const c = await readyClient();
    const disconnected = next(c, 'disconnected');
    await c.stop();
    await disconnected;
    await delay(100);
    expect(engine.connectionCount).toBe(1);
    expect(c.status).toMatchObject({ connected: false, ready: false });
  });
});

describe('requests', () => {
  const BUY = { traderId: 1_000_000, side: 'buy', price: 14_250n, qty: 10n } as const;

  it('resolves a submit with its OrderAccepted', async () => {
    const c = await readyClient();
    const reply = await c.submit(BUY);
    expect(reply).toMatchObject({ type: 'orderAccepted', orderId: 1n, ...BUY });
    expect(engine.messagesOfType('submitOrder')[0]).toMatchObject({ ...BUY, clientTag: 1n });
  });

  it('resolves a submit with its OrderRejected', async () => {
    engine.onSubmit = (message, e) => {
      e.reject(message, 'qtyOutOfRange');
    };
    const c = await readyClient();
    const reply = await c.submit(BUY);
    expect(reply).toMatchObject({ type: 'orderRejected', reason: 'qtyOutOfRange', orderId: 0n });
  });

  it('correlates concurrent submits by clientTag', async () => {
    const held: GatewayMessageOf<'submitOrder'>[] = [];
    engine.onSubmit = (message, e) => {
      held.push(message);
      if (held.length === 2) {
        // Reply in reverse order.
        e.accept(held[1] as GatewayMessageOf<'submitOrder'>);
        e.accept(held[0] as GatewayMessageOf<'submitOrder'>);
      }
    };
    const c = await readyClient();
    const [first, second] = await Promise.all([
      c.submit({ ...BUY, qty: 1n }),
      c.submit({ ...BUY, qty: 2n }),
    ]);
    expect(first).toMatchObject({ type: 'orderAccepted', qty: 1n, orderId: 2n });
    expect(second).toMatchObject({ type: 'orderAccepted', qty: 2n, orderId: 1n });
  });

  it('still emits replies as live events', async () => {
    const c = await readyClient();
    const events = collectEvents(c);
    await c.submit(BUY);
    await until(() => events.length === 2);
    expect(events.map((e) => e.type)).toEqual(['orderAccepted', 'orderRested']);
  });

  it('resolves a cancel with its OrderCancelled', async () => {
    const c = await readyClient();
    const accepted = await c.submit(BUY);
    const reply = await c.cancel({ traderId: BUY.traderId, orderId: accepted.orderId });
    expect(reply).toMatchObject({ type: 'orderCancelled', orderId: accepted.orderId });
  });

  it('resolves a cancel with its OrderRejected', async () => {
    const c = await readyClient();
    const accepted = await c.submit(BUY);
    const notOwner = await c.cancel({ traderId: 1_000_001, orderId: accepted.orderId });
    expect(notOwner).toMatchObject({ type: 'orderRejected', reason: 'notOwner' });
    const unknown = await c.cancel({ traderId: BUY.traderId, orderId: 999n });
    expect(unknown).toMatchObject({ type: 'orderRejected', reason: 'unknownOrderId' });
  });

  it('rejects requests before the snapshot is complete', async () => {
    const c = makeClient();
    await expect(c.submit(BUY)).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(c.cancel({ traderId: 1, orderId: 1n })).rejects.toBeInstanceOf(
      EngineUnavailableError,
    );
  });

  it('rejects a request the engine does not answer in time', async () => {
    let held: GatewayMessageOf<'submitOrder'> | undefined;
    engine.onSubmit = (message) => {
      held = message;
    };
    const c = await readyClient();
    await expect(c.submit(BUY)).rejects.toBeInstanceOf(EngineTimeoutError);
    // A late reply is still delivered as an event and does not resolve anything.
    const events = collectEvents(c);
    engine.accept(held as GatewayMessageOf<'submitOrder'>);
    await until(() => events.length === 2);
  });

  it('rejects in-flight requests when the connection drops', async () => {
    engine.onSubmit = (_message, e) => {
      e.dropConnections();
    };
    const c = await readyClient();
    await expect(c.submit(BUY)).rejects.toBeInstanceOf(EngineDisconnectedError);
  });

  it('rejects a request whose fields do not fit the wire format', async () => {
    const c = await readyClient();
    await expect(c.submit({ ...BUY, traderId: 2 ** 32 })).rejects.toBeInstanceOf(RangeError);
  });
});
