// The browser's one WebSocket connection to the gateway (shared/PROTOCOL.md).
// It authenticates, validates every incoming frame, checks `seq`, feeds the
// store and reconnects with backoff. Session tokens are sent only in `auth`
// and are never logged.
import {
  type ClientMessage,
  type ClientMessageOf,
  type Interval,
  parseServerMessage,
  type ServerMessage,
  type ServerMessageOf,
  type ServerMessageType,
} from '@ome/shared';

import type { Store } from '../state/store.js';
import { backoffDelayMs } from './backoff.js';

// The part of the browser WebSocket the client uses, so tests can supply a fake.
export interface WebSocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface GatewayClientOptions {
  readonly store: Store;
  // Called on every (re)connect, so a token refreshed by the join screen is picked up.
  readonly getToken: () => string;
  readonly url?: string;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly random?: () => number;
  // The gateway rejected the token; the viewer must join again (P1-16).
  readonly onSessionExpired?: () => void;
  readonly logger?: Pick<Console, 'warn'>;
}

type Handler<T extends ServerMessageType> = (message: ServerMessageOf<T>) => void;

export function defaultGatewayUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

export class GatewayClient {
  private readonly store: Store;
  private readonly getToken: () => string;
  private readonly url: string;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly random: () => number;
  private readonly onSessionExpired: (() => void) | undefined;
  private readonly logger: Pick<Console, 'warn'>;
  private readonly handlers = new Map<ServerMessageType, Set<(message: ServerMessage) => void>>();

  private running = false;
  private socket: WebSocketLike | null = null;
  private authenticated = false;
  private lastSeq = 0;
  // Failed attempts since the last successful welcome.
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: GatewayClientOptions) {
    this.store = options.store;
    this.getToken = options.getToken;
    this.url = options.url ?? defaultGatewayUrl(window.location);
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.random = options.random ?? Math.random;
    this.onSessionExpired = options.onSessionExpired;
    this.logger = options.logger ?? console;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.store.dispatch({ type: 'connecting' });
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.cancelReconnect();
    this.dropSocket();
    this.store.dispatch({ type: 'offline' });
  }

  // Subscribes to one server message type, after the store has applied it.
  on<T extends ServerMessageType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(type, set);
    }
    // Only messages of type T are ever delivered to this set.
    const untyped = handler as (message: ServerMessage) => void;
    set.add(untyped);
    return () => {
      set.delete(untyped);
    };
  }

  // Each send returns false, and sends nothing, unless the connection is authenticated.
  placeOrder(order: Omit<ClientMessageOf<'placeOrder'>, 'type'>): boolean {
    return this.send({ type: 'placeOrder', ...order });
  }

  cancelOrder(orderId: number): boolean {
    return this.send({ type: 'cancelOrder', orderId });
  }

  cancelAll(): boolean {
    return this.send({ type: 'cancelAll' });
  }

  setInterval(interval: Interval): boolean {
    return this.send({ type: 'setInterval', interval });
  }

  ping(): boolean {
    return this.send({ type: 'ping' });
  }

  private send(message: ClientMessage): boolean {
    if (this.socket === null || !this.authenticated) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect(): void {
    this.reconnectTimer = null;
    this.lastSeq = 0;
    this.authenticated = false;
    const socket = this.createSocket(this.url);
    this.socket = socket;
    // Events from a socket the client has since dropped are ignored.
    socket.onopen = () => {
      if (socket !== this.socket) return;
      const auth: ClientMessage = { type: 'auth', token: this.getToken() };
      socket.send(JSON.stringify(auth));
    };
    socket.onmessage = (event) => {
      if (socket === this.socket) this.handleFrame(event.data);
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.authenticated = false;
      this.scheduleReconnect();
    };
    // No onerror handler: an error is always followed by close, which does the work.
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      // `detail` never quotes the frame. The dropped message's seq is lost, so
      // the next valid frame looks like a gap and forces a fresh snapshot.
      this.logger.warn(
        `Dropped invalid gateway message (${parsed.error.code}): ${parsed.error.detail}`,
      );
      return;
    }
    const message = parsed.message;
    if (message.seq !== this.lastSeq + 1) {
      this.logger.warn(
        `Gateway message seq ${String(message.seq)} after ${String(this.lastSeq)}; resyncing`,
      );
      this.dropSocket();
      this.scheduleReconnect();
      return;
    }
    this.lastSeq = message.seq;

    if (message.type === 'welcome') {
      this.authenticated = true;
      this.attempt = 0;
    } else if (message.type === 'error' && message.code === 'sessionExpired') {
      this.expireSession();
      this.emit(message);
      return;
    }
    this.store.dispatch({ type: 'server', message });
    this.emit(message);
    // The gateway closes after authRequired; close handling reconnects with a fresh auth.
  }

  private emit(message: ServerMessage): void {
    const set = this.handlers.get(message.type);
    if (set === undefined) return;
    for (const handler of [...set]) handler(message);
  }

  private expireSession(): void {
    this.running = false;
    this.cancelReconnect();
    this.dropSocket();
    this.store.dispatch({ type: 'reset' });
    this.store.dispatch({ type: 'sessionExpired' });
    this.store.dispatch({ type: 'offline' });
    this.onSessionExpired?.();
  }

  // Discards the connection's state and tries again after a backoff delay.
  private scheduleReconnect(): void {
    if (!this.running) return;
    this.store.dispatch({ type: 'reset' });
    this.attempt += 1;
    this.store.dispatch({ type: 'reconnecting', attempt: this.attempt });
    this.reconnectTimer = setTimeout(
      () => {
        this.connect();
      },
      backoffDelayMs(this.attempt, this.random),
    );
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Forgets the current socket before closing it, so its close event is ignored.
  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    socket?.close();
  }
}
