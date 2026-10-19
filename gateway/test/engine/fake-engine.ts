// An in-process stand-in for the C++ engine service: a TCP server speaking the
// internal protocol through the same codec as the gateway. By default it
// answers Hello with HelloAck and a snapshot, sends heartbeats, accepts every
// submit (resting it in full) and honours cancels from the owner. Tests
// override these behaviours to script failures.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';

import { encodeEngineMessage } from '../../src/internal/codec.js';
import { gatewayMessageDecoder } from '../../src/internal/frame-decoder.js';
import {
  PROTOCOL_VERSION,
  type EngineMessage,
  type EngineMessageOf,
  type GatewayMessage,
  type GatewayMessageOf,
} from '../../src/internal/protocol.js';

export interface FakeSnapshot {
  restingOrders: EngineMessageOf<'restingOrder'>[];
  trades: EngineMessageOf<'tradeReplay'>[];
}

export type SubmitHandler = (message: GatewayMessageOf<'submitOrder'>, engine: FakeEngine) => void;
export type CancelHandler = (message: GatewayMessageOf<'cancelOrder'>, engine: FakeEngine) => void;

export interface FakeEngineOptions {
  engineInstanceId?: bigint;
  heartbeatIntervalMs?: number;
}

export class FakeEngine {
  engineInstanceId: bigint;
  snapshot: FakeSnapshot = { restingOrders: [], trades: [] };
  nextEventSeq = 1n;
  nextOrderId = 1n;
  // Resting orders' owners, for the default cancel handler.
  readonly owners = new Map<bigint, number>();
  onSubmit: SubmitHandler = defaultSubmit;
  onCancel: CancelHandler = defaultCancel;
  // Connections to close as soon as they are accepted.
  refuseNext = 0;
  // When set, the engine ignores everything it receives and sends nothing.
  silent = false;

  readonly received: GatewayMessage[] = [];
  readonly acceptedAt: number[] = [];
  #socket: Socket | undefined;
  readonly #sockets = new Set<Socket>();
  readonly #server: Server;
  readonly #heartbeatTimer: NodeJS.Timeout;

  private constructor(server: Server, options: FakeEngineOptions) {
    this.#server = server;
    this.engineInstanceId = options.engineInstanceId ?? 0x1234n;
    server.on('connection', (socket) => {
      this.#accept(socket);
    });
    this.#heartbeatTimer = setInterval(() => {
      if (!this.silent && this.#socket !== undefined) {
        this.send({ type: 'heartbeat', serverTime: BigInt(Date.now()) * 1_000_000n });
      }
    }, options.heartbeatIntervalMs ?? 20);
  }

  static async start(options: FakeEngineOptions = {}): Promise<FakeEngine> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new FakeEngine(server, options);
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get connectionCount(): number {
    return this.acceptedAt.length;
  }

  // Sends to the current connection, if any.
  send(message: EngineMessage): void {
    this.sendRaw(encodeEngineMessage(message));
  }

  sendRaw(bytes: Uint8Array): void {
    this.#socket?.write(bytes);
  }

  // The eventSeq for the next live event.
  seq(): bigint {
    return this.nextEventSeq++;
  }

  dropConnections(): void {
    for (const socket of this.#sockets) socket.destroy();
  }

  messagesOfType<T extends GatewayMessage['type']>(type: T): GatewayMessageOf<T>[] {
    return this.received.filter((m): m is GatewayMessageOf<T> => m.type === type);
  }

  async close(): Promise<void> {
    clearInterval(this.#heartbeatTimer);
    this.dropConnections();
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
  }

  #accept(socket: Socket): void {
    this.acceptedAt.push(Date.now());
    this.#sockets.add(socket);
    socket.on('close', () => {
      this.#sockets.delete(socket);
      if (this.#socket === socket) this.#socket = undefined;
    });
    socket.on('error', () => {
      // The client may reset the connection; 'close' follows.
    });
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      socket.destroy();
      return;
    }
    this.#socket = socket;
    const decoder = gatewayMessageDecoder();
    socket.on('data', (chunk: Buffer) => {
      if (this.silent) return;
      decoder.push(chunk);
      for (;;) {
        const result = decoder.next();
        if (result.kind === 'needMore') return;
        if (result.kind === 'error') throw new Error(`fake engine decode error: ${result.error}`);
        this.received.push(result.message);
        this.#handle(result.message);
      }
    });
  }

  #handle(message: GatewayMessage): void {
    switch (message.type) {
      case 'hello':
        this.send({
          type: 'helloAck',
          protocolVersion: PROTOCOL_VERSION,
          engineInstanceId: this.engineInstanceId,
          serverTime: BigInt(Date.now()) * 1_000_000n,
        });
        this.sendSnapshot();
        return;
      case 'submitOrder':
        this.onSubmit(message, this);
        return;
      case 'cancelOrder':
        this.onCancel(message, this);
        return;
      case 'heartbeat':
        return;
    }
  }

  sendSnapshot(): void {
    this.send({ type: 'snapshotBegin', eventSeq: this.nextEventSeq });
    for (const order of this.snapshot.restingOrders) this.send(order);
    for (const trade of this.snapshot.trades) this.send(trade);
    this.send({ type: 'snapshotEnd', eventSeq: this.nextEventSeq });
  }

  // Accepts a submit and rests it in full.
  accept(message: GatewayMessageOf<'submitOrder'>): bigint {
    const orderId = this.nextOrderId++;
    const ts = BigInt(Date.now()) * 1_000_000n;
    const { clientTag, traderId, side, price, qty } = message;
    this.send({
      type: 'orderAccepted',
      eventSeq: this.seq(),
      ts,
      clientTag,
      orderId,
      traderId,
      side,
      price,
      qty,
    });
    this.send({
      type: 'orderRested',
      eventSeq: this.seq(),
      ts,
      orderId,
      traderId,
      side,
      price,
      remainingQty: qty,
    });
    this.owners.set(orderId, traderId);
    return orderId;
  }

  reject(
    message: { clientTag: bigint; traderId: number },
    reason: EngineMessageOf<'orderRejected'>['reason'],
    orderId = 0n,
  ): void {
    this.send({
      type: 'orderRejected',
      eventSeq: this.seq(),
      ts: BigInt(Date.now()) * 1_000_000n,
      clientTag: message.clientTag,
      orderId,
      traderId: message.traderId,
      reason,
    });
  }
}

function defaultSubmit(message: GatewayMessageOf<'submitOrder'>, engine: FakeEngine): void {
  engine.accept(message);
}

function defaultCancel(message: GatewayMessageOf<'cancelOrder'>, engine: FakeEngine): void {
  const owner = engine.owners.get(message.orderId);
  if (owner === undefined) {
    engine.reject(message, 'unknownOrderId', message.orderId);
  } else if (owner !== message.traderId) {
    engine.reject(message, 'notOwner', message.orderId);
  } else {
    engine.owners.delete(message.orderId);
    engine.send({
      type: 'orderCancelled',
      eventSeq: engine.seq(),
      ts: BigInt(Date.now()) * 1_000_000n,
      orderId: message.orderId,
      traderId: message.traderId,
      cancelledQty: 1n,
    });
  }
}
