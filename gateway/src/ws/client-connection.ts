// One client WebSocket: the auth handshake, validation of every frame,
// keepalive and dispatch of order messages to OrderEntry.
//
//   awaitingAuth  The first frame must be a valid `auth` within the auth
//                 timeout. Anything else gets `error` and the connection
//                 closes; so does a token that does not verify.
//   authenticated Every frame is parsed with the public schemas before it is
//                 acted on. A bad frame gets `error` `badMessage`; after
//                 maxViolations of them the connection closes.
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
import type { HubConnection, OutgoingMessage, SessionHub } from './session-hub.js';

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
}

export interface ConnectionDeps {
  readonly sessions: Pick<SessionService, 'verify'>;
  readonly orderEntry: Pick<OrderEntry, 'placeOrder' | 'cancelOrder' | 'cancelAll'>;
  readonly hub: SessionHub<ClientConnection>;
  readonly limits: ConnectionLimits;
  readonly logger: Logger;
  readonly now: () => number;
}

type State =
  | { readonly kind: 'awaitingAuth' }
  | { readonly kind: 'authenticated'; readonly traderId: number }
  | { readonly kind: 'closed' };

export class ClientConnection implements HubConnection {
  readonly ip: string;
  readonly #socket: WebSocket;
  readonly #deps: ConnectionDeps;
  #log: Logger;
  #state: State = { kind: 'awaitingAuth' };
  #seq = 0;
  #violations = 0;
  #alive = true;
  #interval: Interval = DEFAULT_INTERVAL;
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

  // The candle interval the client asked for (used by P1-13).
  get interval(): Interval {
    return this.#interval;
  }

  // Stamps the next seq and sends. Dropped once the connection is closing.
  send(message: OutgoingMessage): void {
    if (this.#state.kind === 'closed' || this.#socket.readyState !== this.#socket.OPEN) return;
    this.#seq += 1;
    this.#socket.send(JSON.stringify({ ...message, seq: this.#seq }));
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
        // The snapshot for the new interval is sent by P1-13.
        this.#interval = message.interval;
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
      this.#socket.terminate();
      this.#onClose();
      return;
    }
    this.#alive = false;
    this.#socket.ping();
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
