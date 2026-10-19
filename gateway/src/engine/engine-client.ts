// The gateway's connection to the engine service, over the internal protocol
// (protocol/internal-protocol.md).
//
// EngineClient keeps one TCP connection up for as long as it is started:
// handshake, snapshot, then live events, with heartbeats both ways. Any
// protocol violation, heartbeat timeout or socket error drops the connection,
// and it reconnects with exponential backoff. Every connection begins with a
// fresh snapshot, so the rest of the gateway can rebuild its state from the
// `snapshot` event and need not reason about what was missed.
//
// Requests (submit, cancel) are only accepted once the snapshot is complete.
// A request that is in flight when the connection drops is rejected with
// EngineDisconnectedError, even though the engine may have processed it; the
// next snapshot shows the outcome.
import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

import type { Logger } from 'pino';

import { encodeGatewayMessage } from '../internal/codec.js';
import { engineMessageDecoder, type FrameDecoder } from '../internal/frame-decoder.js';
import {
  PROTOCOL_VERSION,
  type ENGINE_MESSAGE_LAYOUTS,
  type EngineMessage,
  type EngineMessageOf,
  type GatewayMessage,
  type Side,
} from '../internal/protocol.js';
import { backoffDelay, type BackoffOptions } from './backoff.js';

export type RestingOrderMessage = EngineMessageOf<'restingOrder'>;
export type TradeReplayMessage = EngineMessageOf<'tradeReplay'>;
export type TradeMessage = EngineMessageOf<'trade'>;
export type OrderAcceptedMessage = EngineMessageOf<'orderAccepted'>;
export type OrderRejectedMessage = EngineMessageOf<'orderRejected'>;
export type OrderRestedMessage = EngineMessageOf<'orderRested'>;
export type OrderCancelledMessage = EngineMessageOf<'orderCancelled'>;

export type LiveEvent =
  | TradeMessage
  | OrderAcceptedMessage
  | OrderRejectedMessage
  | OrderRestedMessage
  | OrderCancelledMessage;

export interface EngineSnapshot {
  readonly engineInstanceId: bigint;
  // Bids then asks, each in price-time order.
  readonly restingOrders: readonly RestingOrderMessage[];
  // Retained trades, oldest first.
  readonly trades: readonly TradeReplayMessage[];
  // The eventSeq of the first live event to follow.
  readonly nextEventSeq: bigint;
}

export interface EngineClientEvents {
  // HelloAck received. A snapshot follows.
  connected: [info: { engineInstanceId: bigint; serverTime: bigint }];
  // The engine service restarted since the last connection: its order IDs and
  // eventSeq start again. Emitted just before `connected`.
  engineReset: [info: { previousInstanceId: bigint; engineInstanceId: bigint }];
  // The snapshot is complete; live events follow.
  snapshot: [snapshot: EngineSnapshot];
  // One live event, in eventSeq order with no gaps.
  event: [event: LiveEvent];
  // A connection that had emitted `connected` has closed.
  disconnected: [info: { reason: string }];
}

export interface EngineStatus {
  readonly connected: boolean; // handshake complete
  readonly ready: boolean; // snapshot complete; requests are accepted
  readonly engineInstanceId: bigint | undefined; // of the current or last engine
}

export interface EngineClientOptions {
  readonly host: string;
  readonly port: number;
  readonly logger: Logger;
  readonly heartbeatIntervalMs?: number;
  // Drop the connection if nothing arrives for this long.
  readonly heartbeatTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly reconnect?: BackoffOptions;
  readonly random?: () => number;
}

export interface SubmitRequest {
  readonly traderId: number;
  readonly side: Side;
  readonly price: bigint;
  readonly qty: bigint;
}

export interface CancelRequest {
  readonly traderId: number;
  readonly orderId: bigint;
}

export class EngineRequestError extends Error {}

// The client is not connected, or the snapshot is not complete yet.
export class EngineUnavailableError extends EngineRequestError {
  override readonly name = 'EngineUnavailableError';
}

// The connection closed before the engine replied.
export class EngineDisconnectedError extends EngineRequestError {
  override readonly name = 'EngineDisconnectedError';
}

// The engine did not reply within requestTimeoutMs.
export class EngineTimeoutError extends EngineRequestError {
  override readonly name = 'EngineTimeoutError';
}

type Phase = 'handshake' | 'awaitSnapshot' | 'snapshot' | 'live';

interface Connection {
  readonly socket: Socket;
  readonly decoder: FrameDecoder<typeof ENGINE_MESSAGE_LAYOUTS>;
  readonly heartbeatTimer: NodeJS.Timeout;
  socketConnected: boolean;
  phase: Phase;
  lastReceivedAt: number;
  restingOrders: RestingOrderMessage[];
  trades: TradeReplayMessage[];
  snapshotSeq: bigint;
  nextEventSeq: bigint;
  closeReason: string | undefined;
  closed: boolean;
}

interface Pending {
  readonly clientTag: bigint;
  readonly timer: NodeJS.Timeout;
  readonly reject: (error: Error) => void;
  readonly request:
    | { readonly kind: 'submit'; readonly resolve: (reply: SubmitReply) => void }
    | {
        readonly kind: 'cancel';
        readonly traderId: number;
        readonly orderId: bigint;
        readonly resolve: (reply: CancelReply) => void;
      };
}

export type SubmitReply = OrderAcceptedMessage | OrderRejectedMessage;
export type CancelReply = OrderCancelledMessage | OrderRejectedMessage;

const DEFAULTS = {
  heartbeatIntervalMs: 1000,
  heartbeatTimeoutMs: 5000,
  requestTimeoutMs: 5000,
  reconnect: { initialMs: 250, maxMs: 10_000 },
} as const;

export class EngineClient extends EventEmitter<EngineClientEvents> {
  readonly #host: string;
  readonly #port: number;
  readonly #log: Logger;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #reconnect: BackoffOptions;
  readonly #random: () => number;

  #running = false;
  #connection: Connection | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #reconnectAttempt = 0;
  #connected = false;
  #ready = false;
  #engineInstanceId: bigint | undefined;

  #nextClientTag = 1n;
  readonly #pending = new Map<bigint, Pending>();
  // Pending cancels by target order, oldest first. A successful cancel is
  // reported by OrderCancelled, which carries no clientTag.
  readonly #pendingCancels = new Map<bigint, Pending[]>();

  constructor(options: EngineClientOptions) {
    super();
    this.#host = options.host;
    this.#port = options.port;
    this.#log = options.logger.child({ component: 'engine-client' });
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULTS.heartbeatIntervalMs;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.#reconnect = options.reconnect ?? DEFAULTS.reconnect;
    this.#random = options.random ?? Math.random;
  }

  get status(): EngineStatus {
    return {
      connected: this.#connected,
      ready: this.#ready,
      engineInstanceId: this.#engineInstanceId,
    };
  }

  // Connects, and keeps reconnecting until stop().
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#reconnectAttempt = 0;
    this.#connect();
  }

  // Closes the connection and stops reconnecting. Pending requests are
  // rejected. Resolves once the socket has closed.
  stop(): Promise<void> {
    this.#running = false;
    if (this.#reconnectTimer !== undefined) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    const connection = this.#connection;
    if (connection === undefined || connection.closed) return Promise.resolve();
    const closed = new Promise<void>((resolve) => connection.socket.once('close', resolve));
    this.#drop(connection, 'client stopped');
    return closed;
  }

  // Submits a limit order. Resolves with the engine's OrderAccepted or
  // OrderRejected for it.
  submit(request: SubmitRequest): Promise<SubmitReply> {
    return new Promise<SubmitReply>((resolve, reject) => {
      this.#request(
        (clientTag) => ({ type: 'submitOrder', clientTag, ...request }),
        { kind: 'submit', resolve },
        reject,
      );
    });
  }

  // Cancels a resting order on behalf of traderId. Resolves with the
  // OrderCancelled, or the OrderRejected (NotOwner, UnknownOrderId).
  cancel(request: CancelRequest): Promise<CancelReply> {
    return new Promise<CancelReply>((resolve, reject) => {
      this.#request(
        (clientTag) => ({ type: 'cancelOrder', clientTag, ...request }),
        { kind: 'cancel', traderId: request.traderId, orderId: request.orderId, resolve },
        reject,
      );
    });
  }

  #request(
    build: (clientTag: bigint) => GatewayMessage,
    request: Pending['request'],
    reject: (error: Error) => void,
  ): void {
    const connection = this.#connection;
    if (!this.#ready || connection === undefined) {
      reject(new EngineUnavailableError('Engine service is not available'));
      return;
    }
    const clientTag = this.#nextClientTag++;
    let frame: Uint8Array;
    try {
      // Throws RangeError if a field does not fit its wire type.
      frame = encodeGatewayMessage(build(clientTag));
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const timer = setTimeout(() => {
      this.#forget(pending);
      reject(new EngineTimeoutError(`No reply from engine service within ${String(this.#requestTimeoutMs)} ms`));
    }, this.#requestTimeoutMs);
    const pending: Pending = { clientTag, timer, reject, request };
    this.#pending.set(clientTag, pending);
    if (request.kind === 'cancel') {
      const queue = this.#pendingCancels.get(request.orderId);
      if (queue === undefined) this.#pendingCancels.set(request.orderId, [pending]);
      else queue.push(pending);
    }
    connection.socket.write(frame);
  }

  #forget(pending: Pending): void {
    clearTimeout(pending.timer);
    this.#pending.delete(pending.clientTag);
    if (pending.request.kind !== 'cancel') return;
    const queue = this.#pendingCancels.get(pending.request.orderId);
    if (queue === undefined) return;
    const index = queue.indexOf(pending);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.#pendingCancels.delete(pending.request.orderId);
  }

  #connect(): void {
    this.#log.debug({ host: this.#host, port: this.#port }, 'connecting to engine service');
    const socket = connect({ host: this.#host, port: this.#port });
    socket.setNoDelay(true);
    const connection: Connection = {
      socket,
      decoder: engineMessageDecoder(),
      // Started now rather than on connect, so a connect or handshake that
      // hangs is also timed out.
      heartbeatTimer: setInterval(() => {
        this.#onHeartbeatTick(connection);
      }, this.#heartbeatIntervalMs),
      socketConnected: false,
      phase: 'handshake',
      lastReceivedAt: Date.now(),
      restingOrders: [],
      trades: [],
      snapshotSeq: 0n,
      nextEventSeq: 0n,
      closeReason: undefined,
      closed: false,
    };
    this.#connection = connection;

    socket.on('connect', () => {
      connection.socketConnected = true;
      connection.lastReceivedAt = Date.now();
      this.#send(connection, { type: 'hello', protocolVersion: PROTOCOL_VERSION });
    });
    socket.on('data', (chunk: Buffer) => {
      this.#onData(connection, chunk);
    });
    socket.on('end', () => {
      connection.closeReason ??= 'engine service closed the connection';
    });
    socket.on('error', (error) => {
      connection.closeReason ??= error.message;
    });
    socket.on('close', () => {
      this.#onClose(connection);
    });
  }

  #send(connection: Connection, message: GatewayMessage): void {
    if (!connection.closed) connection.socket.write(encodeGatewayMessage(message));
  }

  #onHeartbeatTick(connection: Connection): void {
    if (Date.now() - connection.lastReceivedAt >= this.#heartbeatTimeoutMs) {
      this.#drop(connection, `nothing received for ${String(this.#heartbeatTimeoutMs)} ms`);
      return;
    }
    if (connection.socketConnected) this.#send(connection, { type: 'heartbeat' });
  }

  // Closes the connection; #onClose does the cleanup.
  #drop(connection: Connection, reason: string): void {
    if (connection.closed) return;
    connection.closeReason ??= reason;
    connection.socket.destroy();
  }

  #onClose(connection: Connection): void {
    if (connection.closed) return;
    connection.closed = true;
    clearInterval(connection.heartbeatTimer);
    // A connection replaced by a stop() then start() owns no client state.
    if (this.#connection !== connection) return;
    this.#connection = undefined;

    const reason = connection.closeReason ?? 'connection closed';
    const wasConnected = connection.phase !== 'handshake';
    this.#connected = false;
    this.#ready = false;

    for (const pending of [...this.#pending.values()]) {
      this.#forget(pending);
      pending.reject(new EngineDisconnectedError(`Engine connection lost: ${reason}`));
    }

    if (wasConnected) {
      this.#log.warn({ reason }, 'disconnected from engine service');
      this.emit('disconnected', { reason });
    } else {
      this.#log.debug({ reason }, 'engine service connection attempt failed');
    }

    if (this.#running) this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const delay = backoffDelay(this.#reconnectAttempt, this.#reconnect, this.#random);
    this.#reconnectAttempt += 1;
    this.#log.debug({ delayMs: delay, attempt: this.#reconnectAttempt }, 'reconnecting');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      if (this.#running) this.#connect();
    }, delay);
  }

  #onData(connection: Connection, chunk: Uint8Array): void {
    if (connection.closed) return;
    connection.lastReceivedAt = Date.now();
    connection.decoder.push(chunk);
    for (;;) {
      const result = connection.decoder.next();
      if (result.kind === 'needMore') return;
      if (result.kind === 'error') {
        this.#violation(connection, `protocol error: ${result.error}`);
        return;
      }
      this.#handle(connection, result.message);
      // #handle may have dropped the connection, which TypeScript cannot see.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (connection.closed) return;
    }
  }

  #violation(connection: Connection, reason: string): void {
    this.#log.error({ reason }, 'engine service protocol violation');
    this.#drop(connection, reason);
  }

  #handle(connection: Connection, message: EngineMessage): void {
    switch (message.type) {
      case 'heartbeat':
        return;

      case 'helloAck': {
        if (connection.phase !== 'handshake') break;
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.#violation(
            connection,
            `protocol version ${String(message.protocolVersion)}, expected ${String(PROTOCOL_VERSION)}`,
          );
          return;
        }
        connection.phase = 'awaitSnapshot';
        const previousInstanceId = this.#engineInstanceId;
        const { engineInstanceId, serverTime } = message;
        this.#engineInstanceId = engineInstanceId;
        this.#connected = true;
        this.#log.info(
          { engineInstanceId: engineInstanceId.toString() },
          'connected to engine service',
        );
        if (previousInstanceId !== undefined && previousInstanceId !== engineInstanceId) {
          this.#log.warn(
            {
              previousInstanceId: previousInstanceId.toString(),
              engineInstanceId: engineInstanceId.toString(),
            },
            'engine service restarted',
          );
          this.emit('engineReset', { previousInstanceId, engineInstanceId });
        }
        this.emit('connected', { engineInstanceId, serverTime });
        return;
      }

      case 'snapshotBegin':
        if (connection.phase !== 'awaitSnapshot') break;
        connection.phase = 'snapshot';
        connection.snapshotSeq = message.eventSeq;
        return;

      case 'restingOrder':
        if (connection.phase !== 'snapshot') break;
        connection.restingOrders.push(message);
        return;

      case 'tradeReplay':
        if (connection.phase !== 'snapshot') break;
        connection.trades.push(message);
        return;

      case 'snapshotEnd': {
        if (connection.phase !== 'snapshot') break;
        if (message.eventSeq !== connection.snapshotSeq) {
          this.#violation(
            connection,
            `SnapshotEnd eventSeq ${String(message.eventSeq)} differs from SnapshotBegin ${String(connection.snapshotSeq)}`,
          );
          return;
        }
        connection.phase = 'live';
        connection.nextEventSeq = message.eventSeq;
        const snapshot: EngineSnapshot = {
          engineInstanceId: this.#engineInstanceId ?? 0n,
          restingOrders: connection.restingOrders,
          trades: connection.trades,
          nextEventSeq: message.eventSeq,
        };
        connection.restingOrders = [];
        connection.trades = [];
        this.#ready = true;
        this.#reconnectAttempt = 0;
        this.#log.info(
          {
            restingOrders: snapshot.restingOrders.length,
            trades: snapshot.trades.length,
            nextEventSeq: snapshot.nextEventSeq.toString(),
          },
          'engine snapshot received',
        );
        this.emit('snapshot', snapshot);
        return;
      }

      case 'trade':
      case 'orderAccepted':
      case 'orderRejected':
      case 'orderRested':
      case 'orderCancelled':
        if (connection.phase !== 'live') break;
        if (message.eventSeq !== connection.nextEventSeq) {
          this.#violation(
            connection,
            `eventSeq ${String(message.eventSeq)}, expected ${String(connection.nextEventSeq)}`,
          );
          return;
        }
        connection.nextEventSeq += 1n;
        this.#settle(message);
        this.emit('event', message);
        return;
    }
    this.#violation(connection, `unexpected ${message.type} during ${connection.phase}`);
  }

  // Resolves the request a live event answers, if any.
  #settle(event: LiveEvent): void {
    switch (event.type) {
      case 'orderAccepted': {
        const pending = this.#pending.get(event.clientTag);
        if (pending?.request.kind !== 'submit') return;
        this.#forget(pending);
        pending.request.resolve(event);
        return;
      }
      case 'orderRejected': {
        const pending = this.#pending.get(event.clientTag);
        if (pending === undefined) return;
        this.#forget(pending);
        pending.request.resolve(event);
        return;
      }
      case 'orderCancelled': {
        const pending = this.#pendingCancels
          .get(event.orderId)
          ?.find((p) => p.request.kind === 'cancel' && p.request.traderId === event.traderId);
        if (pending?.request.kind !== 'cancel') return;
        this.#forget(pending);
        pending.request.resolve(event);
        return;
      }
      case 'trade':
      case 'orderRested':
        return;
    }
  }
}
