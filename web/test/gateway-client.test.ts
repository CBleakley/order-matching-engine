import type { ServerMessage } from '@ome/shared';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { BACKOFF_BASE_MS } from '../src/connection/backoff.js';
import {
  defaultGatewayUrl,
  GatewayClient,
  type WebSocketLike,
} from '../src/connection/gateway-client.js';
import { createStore, type Store } from '../src/state/store.js';
import { bar, fill, snapshot, welcome } from './messages.js';

const TOKEN = 'secret-session-token';

class MockWebSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: unknown[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.closed = true;
  }

  // Test helpers: what the gateway or the network would do.
  open(): void {
    this.onopen?.(new Event('open'));
  }

  receive(message: ServerMessage | string): void {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  serverClose(): void {
    this.closed = true;
    this.onclose?.(new CloseEvent('close'));
  }
}

let sockets: MockWebSocket[];
let store: Store;
let logger: { warn: Mock<(message: string) => void> };
let onSessionExpired: Mock<() => void>;

function makeClient(): GatewayClient {
  return new GatewayClient({
    store,
    getToken: () => TOKEN,
    url: 'ws://test/ws',
    createSocket: (url) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    // Always the longest delay, so tests know exactly when a reconnect fires.
    random: () => 1,
    onSessionExpired,
    logger,
  });
}

function latest(): MockWebSocket {
  const socket = sockets.at(-1);
  if (socket === undefined) throw new Error('no socket created');
  return socket;
}

// Opens the newest socket and completes auth: welcome, then snapshot.
function connect(): MockWebSocket {
  const socket = latest();
  socket.open();
  socket.receive(welcome(1));
  socket.receive(snapshot(2));
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  store = createStore();
  logger = { warn: vi.fn() };
  onSessionExpired = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayClient', () => {
  it('sends auth first, then goes live on welcome and snapshot', () => {
    const client = makeClient();
    client.start();
    expect(store.getState().connection).toEqual({ kind: 'connecting' });

    const socket = latest();
    expect(socket.url).toBe('ws://test/ws');
    socket.open();
    expect(socket.sent).toEqual([{ type: 'auth', token: TOKEN }]);

    socket.receive(welcome(1));
    expect(store.getState().me).toEqual({ traderId: 1_000_001, name: 'Ada' });
    socket.receive(snapshot(2));
    expect(store.getState().connection).toEqual({ kind: 'live' });
    expect(store.getState().candles).toHaveLength(2);
  });

  it('refuses to send before auth completes', () => {
    const client = makeClient();
    client.start();
    latest().open();
    expect(client.cancelAll()).toBe(false);
    expect(latest().sent).toEqual([{ type: 'auth', token: TOKEN }]);
  });

  it('sends typed requests once authenticated', () => {
    const client = makeClient();
    client.start();
    const socket = connect();

    expect(
      client.placeOrder({ clientOrderId: 'c-1', side: 'sell', qty: 3, priceTicks: 14300 }),
    ).toBe(true);
    expect(client.cancelOrder(4)).toBe(true);
    expect(client.cancelAll()).toBe(true);
    expect(client.setInterval('1m')).toBe(true);
    expect(client.ping()).toBe(true);
    expect(socket.sent.slice(1)).toEqual([
      { type: 'placeOrder', clientOrderId: 'c-1', side: 'sell', qty: 3, priceTicks: 14300 },
      { type: 'cancelOrder', orderId: 4 },
      { type: 'cancelAll' },
      { type: 'setInterval', interval: '1m' },
      { type: 'ping' },
    ]);
  });

  it('emits typed events after the store has applied the message', () => {
    const client = makeClient();
    const seen: number[] = [];
    const off = client.on('fill', (message) => {
      seen.push(message.orderId);
      expect(store.getState().fills[0]?.orderId).toBe(message.orderId);
    });
    client.start();
    const socket = connect();
    socket.receive({ type: 'fill', seq: 3, ...fill(42) });
    off();
    socket.receive({ type: 'fill', seq: 4, ...fill(43) });
    expect(seen).toEqual([42]);
  });

  it('drops and logs invalid frames without quoting them', () => {
    const client = makeClient();
    client.start();
    const socket = connect();
    const before = store.getState();

    socket.receive(`not json ${TOKEN}`);
    socket.receive(JSON.stringify({ type: 'stats', seq: 3, last: 1.5, token: TOKEN }));
    socket.receive(JSON.stringify({ type: 'mystery', seq: 3 }));

    expect(store.getState()).toBe(before);
    expect(logger.warn).toHaveBeenCalledTimes(3);
    for (const call of logger.warn.mock.calls) {
      expect(call[0]).toMatch(/^Dropped invalid gateway message/);
      expect(call[0]).not.toContain(TOKEN);
    }
  });

  it('ignores binary frames', () => {
    const client = makeClient();
    client.start();
    const socket = connect();
    const before = store.getState();
    socket.onmessage?.(new MessageEvent('message', { data: new ArrayBuffer(4) }));
    expect(store.getState()).toBe(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('on a seq gap discards state, reconnects and applies the fresh snapshot', () => {
    const client = makeClient();
    client.start();
    const first = connect();

    first.receive({ type: 'candles', seq: 4, interval: '15s', bars: [bar(45_000)] });
    expect(first.closed).toBe(true);
    expect(store.getState().candles).toEqual([]);
    expect(store.getState().me).toBeNull();
    expect(store.getState().connection).toEqual({ kind: 'reconnecting', attempt: 1 });
    expect(logger.warn).toHaveBeenCalledWith('Gateway message seq 4 after 2; resyncing');

    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(2);
    const second = latest();
    second.open();
    expect(second.sent).toEqual([{ type: 'auth', token: TOKEN }]);
    second.receive(welcome(1));
    second.receive(snapshot(2, { candles: [bar(60_000)] }));
    expect(store.getState().candles).toEqual([bar(60_000)]);
    expect(store.getState().connection).toEqual({ kind: 'live' });
  });

  it('ignores events from a socket it has dropped', () => {
    const client = makeClient();
    client.start();
    const first = connect();
    first.receive(snapshot(5));
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    connect();

    first.receive(welcome(1));
    first.serverClose();
    expect(store.getState().connection).toEqual({ kind: 'live' });
    expect(sockets).toHaveLength(2);
  });

  it('reconnects with growing backoff, and resets it after a welcome', () => {
    const client = makeClient();
    client.start();
    latest().serverClose();
    expect(store.getState().connection).toEqual({ kind: 'reconnecting', attempt: 1 });

    // Attempt 1 waits BASE, attempt 2 waits 2 * BASE.
    vi.advanceTimersByTime(BACKOFF_BASE_MS - 1);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    latest().serverClose();
    expect(store.getState().connection).toEqual({ kind: 'reconnecting', attempt: 2 });
    vi.advanceTimersByTime(2 * BACKOFF_BASE_MS - 1);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    connect();
    expect(store.getState().connection).toEqual({ kind: 'live' });
    latest().serverClose();
    expect(store.getState().connection).toEqual({ kind: 'reconnecting', attempt: 1 });
    expect(store.getState().candles).toEqual([]);
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(4);
  });

  it('on sessionExpired stops, clears state and hands over to the join screen', () => {
    const client = makeClient();
    client.start();
    const socket = connect();
    const seen = vi.fn();
    client.on('error', seen);

    socket.receive({ type: 'error', seq: 3, code: 'sessionExpired', message: 'Join again' });
    expect(socket.closed).toBe(true);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledTimes(1);
    const state = store.getState();
    expect(state.sessionExpired).toBe(true);
    expect(state.connection).toEqual({ kind: 'offline' });
    expect(state.me).toBeNull();
    expect(state.candles).toEqual([]);

    socket.serverClose();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(client.ping()).toBe(false);
  });

  it('reconnects after authRequired, which the gateway follows with a close', () => {
    const client = makeClient();
    client.start();
    const socket = latest();
    socket.open();
    socket.receive({ type: 'error', seq: 1, code: 'authRequired', message: 'Auth first' });
    socket.serverClose();
    expect(store.getState().connection).toEqual({ kind: 'reconnecting', attempt: 1 });
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(sockets).toHaveLength(2);
  });

  it('stop closes the socket, cancels any reconnect and goes offline', () => {
    const client = makeClient();
    client.start();
    const socket = connect();
    client.stop();
    expect(socket.closed).toBe(true);
    expect(store.getState().connection).toEqual({ kind: 'offline' });
    expect(client.cancelAll()).toBe(false);

    client.start();
    latest().serverClose();
    client.stop();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
    expect(store.getState().connection).toEqual({ kind: 'offline' });
  });
});

describe('defaultGatewayUrl', () => {
  it('uses wss on https pages and ws otherwise', () => {
    expect(defaultGatewayUrl({ protocol: 'https:', host: 'demo.example:443' })).toBe(
      'wss://demo.example:443/ws',
    );
    expect(defaultGatewayUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws',
    );
  });
});
