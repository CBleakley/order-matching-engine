// One client WebSocket: the auth handshake, validation of every frame,
// keepalive, dispatch of order messages to OrderEntry and flow control for
// market data.
//
//   awaitingAuth  The first frame must be a valid `auth` within the auth
//                 timeout. Anything else gets `error` and the connection
//                 closes; so does a token that does not verify. A valid one
//                 gets `welcome`, then `snapshot`.
//   authenticated Every frame is parsed with the public schemas before it is
//                 acted on. A bad frame gets `error` `badMessage`; after
//                 maxViolations of them the connection closes.
//
// Private messages (order replies and the trader's own updates) are sent as
// they happen. Market data arrives from the MarketFeed once per flush:
//
//   - While more than maxBufferedBytes are queued on the socket, market data
//     is dropped. Once the queue drains, the connection gets a fresh
//     `snapshot` instead of the backlog. If it stays over the limit for
//     stallTimeoutMs, the socket is terminated: a close frame would only queue
//     behind the stuck data.
//   - A pending snapshot (after setInterval, or after the engine reconnects)
//     goes out on the next flush in place of the deltas. So a client cannot
//     make the gateway build snapshots faster than once per flush.
//
// Dropped messages are never stamped, so `seq` has no gaps.
//
// Nothing here logs a frame or a token: frames can contain the token.
import {
  INSTRUMENT,
  parseClientMessage,
  type ClientMessage,
  type ErrorCode,
  type Interval,
} from '@ome/shared';
import type { Logger } from 'pino';
import type { RawData, WebSocket } from 'ws';

import type { OrderEntry, OrderReply } from '../orders/order-entry.js';
import type { SessionService } from '../session/session-service.js';
import type { FeedConnection, MarketUpdate } from './market-feed.js';
import type { OutgoingMessage, SessionHub } from './session-hub.js';

// WebSocket close codes (RFC 6455 section 7.4.1).
export const CLOSE_NORMAL = 1000;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_TRY_AGAIN_LATER = 1013;

const DEFAULT_INTERVAL: Interval = '15s';

export interface ConnectionLimits {
  readonly authTimeoutMs: number;
  readonly pingIntervalMs: number;
  readonly maxViolations: number;
  readonly maxBufferedBytes: number;
  readonly stallTimeoutMs: number;
}

export interface ConnectionDeps {
  readonly sessions: Pick<SessionService, 'verify'>;
  readonly orderEntry: Pick<OrderEntry, 'placeOrder' | 'cancelOrder' | 'cancelAll'>;
  readonly hub: SessionHub<ClientConnection>;
  // The full `snapshot` message for a trader and candle interval.
  readonly snapshot: (traderId: number, interval: Interval) => OutgoingMessage;
  readonly limits: ConnectionLimits;
  readonly logger: Logger;
  readonly now: () => number;
}

type State =
  | { readonly kind: 'awaitingAuth' }
  | { readonly kind: 'authenticated'; readonly traderId: number }
  | { readonly kind: 'closed' };

export class ClientConnection implements FeedConnection {
  readonly ip: string;
  readonly #socket: WebSocket;
  readonly #deps: ConnectionDeps;
  #log: Logger;
  #state: State = { kind: 'awaitingAuth' };
  #seq = 0;
  #violations = 0;
  #alive = true;
  #interval: Interval = DEFAULT_INTERVAL;
  #needsSnapshot = false;
  // When the socket's queue first went over maxBufferedBytes; undefined while under.
  #stalledSince: number | undefined;
  readonly #authTimer: NodeJS.Timeout;
  readonly #pingTimer: NodeJS.Timeout;

  constructor(socket: WebSocket, ip: string, deps: ConnectionDeps) {
    this.#socket = socket;
    this.ip = ip;
    this.#deps = deps;
    this.#log = deps.logger;

    this.#authTimer = setTimeout(() => {
      this.#fail('authRequired', 'No auth message received in time');
    }, deps.limits.authTimeoutMs);
    this.#pingTimer = setInterval(() => {
      this.#keepalive();
    }, deps.limits.pingIntervalMs);

    socket.on('message', (data, isBinary) => {
      this.#onFrame(data, isBinary);
    });
    socket.on('pong', () => {
      this.#alive = true;
    });
    socket.on('error', (error) => {
      // An oversize frame or invalid UTF-8 lands here; ws closes the socket.
      this.#log.debug({ err: error }, 'client websocket error');
    });
    socket.on('close', () => {
      this.#onClose();
    });
    deps.hub.add(this);
  }

  get traderId(): number | undefined {
    return this.#state.kind === 'authenticated' ? this.#state.traderId : undefined;
  }

  // The candle interval the client asked for.
  get interval(): Interval {
    return this.#interval;
  }

  // Stamps the next seq and sends. Dropped once the connection is closing.
  send(message: OutgoingMessage): void {
    if (this.#state.kind === 'closed' || this.#socket.readyState !== this.#socket.OPEN) return;
    this.#seq += 1;
    this.#socket.send(JSON.stringify({ ...message, seq: this.#seq }));
  }

  // Sends the connection's whole state; a no-op before auth.
  sendSnapshot(): void {
    if (this.#state.kind !== 'authenticated') return;
    this.send(this.#deps.snapshot(this.#state.traderId, this.#interval));
  }

  // Sends a snapshot on the next flush instead of that flush's market data.
  requestSnapshot(): void {
    this.#needsSnapshot = true;
  }

  flushMarketData(update: MarketUpdate): void {
    if (this.#state.kind !== 'authenticated') return;
    const { traderId } = this.#state;
    const { maxBufferedBytes, stallTimeoutMs } = this.#deps.limits;
    if (this.#socket.bufferedAmount > maxBufferedBytes) {
      const now = this.#deps.now();
      if (this.#stalledSince === undefined) {
        this.#stalledSince = now;
        this.#log.info({ bufferedBytes: this.#socket.bufferedAmount }, 'websocket stalled');
      } else if (now - this.#stalledSince >= stallTimeoutMs) {
        this.#log.info({ bufferedBytes: this.#socket.bufferedAmount }, 'closing stalled websocket');
        this.#terminate();
      }
      return;
    }
    if (this.#stalledSince !== undefined) {
      this.#stalledSince = undefined;
      this.#needsSnapshot = true;
    }
    if (this.#needsSnapshot) {
      this.#needsSnapshot = false;
      this.sendSnapshot();
      return;
    }
    const bars = update.bars.get(this.#interval);
    if (bars !== undefined && bars.length > 0) {
      this.send({ type: 'candles', interval: this.#interval, bars: [...bars] });
    }
    if (update.stats !== undefined) this.send({ type: 'stats', ...update.stats });
    const position = update.positionOf(traderId);
    if (position !== undefined) this.send({ type: 'position', ...position });
  }

  close(code: number, reason: string): void {
    if (this.#state.kind === 'closed') return;
    this.#socket.close(code, reason);
    this.#onClose();
  }

  #onFrame(data: RawData, isBinary: boolean): void {
    if (this.#state.kind === 'closed') return;
    if (isBinary) {
      this.#badMessage('Binary frames are not accepted; send JSON text');
      return;
    }
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) {
      // `detail` describes the expectation and never quotes the frame.
      this.#badMessage(parsed.error.detail);
      return;
    }
    if (this.#state.kind === 'awaitingAuth') {
      this.#onFirstMessage(parsed.message);
    } else {
      this.#dispatch(this.#state.traderId, parsed.message);
    }
  }

  #onFirstMessage(message: ClientMessage): void {
    clearTimeout(this.#authTimer);
    if (message.type !== 'auth') {
      this.#fail('authRequired', 'The first message must be auth');
      return;
    }
    const result = this.#deps.sessions.verify(message.token);
    if (!result.ok) {
      this.#log.info({ reason: result.reason }, 'websocket auth rejected');
      this.#fail('sessionExpired', 'Your session has expired; join again');
      return;
    }
    const { traderId, name } = result.claims;
    this.#state = { kind: 'authenticated', traderId };
    this.#log = this.#log.child({ traderId });
    this.#deps.hub.authenticate(this, traderId);
    this.#log.info('websocket authenticated');
    this.send({
      type: 'welcome',
      you: { traderId, name },
      instrument: INSTRUMENT,
      serverTime: this.#deps.now(),
    });
    this.sendSnapshot();
  }

  #dispatch(traderId: number, message: ClientMessage): void {
    const reply = (orderReply: OrderReply): void => {
      this.send(orderReply);
    };
    switch (message.type) {
      case 'auth':
        this.#badMessage('Already authenticated');
        return;
      case 'placeOrder':
        this.#deps.orderEntry.placeOrder(traderId, message, reply);
        return;
      case 'cancelOrder':
        this.#deps.orderEntry.cancelOrder(traderId, message, reply);
        return;
      case 'cancelAll':
        this.#deps.orderEntry.cancelAll(traderId, reply);
        return;
      case 'setInterval':
        this.#interval = message.interval;
        this.requestSnapshot();
        return;
      case 'ping':
        this.send({ type: 'pong' });
        return;
    }
  }

  #badMessage(detail: string): void {
    if (this.#state.kind === 'awaitingAuth') {
      clearTimeout(this.#authTimer);
      this.#fail('badMessage', detail);
      return;
    }
    this.#violations += 1;
    this.send({ type: 'error', code: 'badMessage', message: detail });
    if (this.#violations >= this.#deps.limits.maxViolations) {
      this.#log.info({ violations: this.#violations }, 'closing websocket after bad messages');
      this.close(CLOSE_POLICY_VIOLATION, 'Too many bad messages');
    }
  }

  // Sends `error` and closes.
  #fail(code: ErrorCode, message: string): void {
    this.send({ type: 'error', code, message });
    this.close(CLOSE_POLICY_VIOLATION, code);
  }

  #keepalive(): void {
    if (!this.#alive) {
      this.#log.info('closing unresponsive websocket');
      this.#terminate();
      return;
    }
    this.#alive = false;
    this.#socket.ping();
  }

  #terminate(): void {
    this.#socket.terminate();
    this.#onClose();
  }

  #onClose(): void {
    if (this.#state.kind === 'closed') return;
    this.#state = { kind: 'closed' };
    clearTimeout(this.#authTimer);
    clearInterval(this.#pingTimer);
    this.#deps.hub.remove(this);
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(new Uint8Array(data)).toString('utf8');
}
