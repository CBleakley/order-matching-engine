// The public WebSocket endpoint, GET /ws (protocol: shared/PROTOCOL.md).
//
// Before the upgrade, a request is refused with a plain HTTP status if its
// Origin is not allowed (403), the gateway is at its total connection cap
// (503) or the client IP is at its per-IP cap (429). request.ip honours the
// server's trustProxy setting. Frames above maxMessageBytes are refused by ws
// itself, which closes the connection with 1009.
//
// When the engine service restarts, its book is gone and every session token
// is stale, so every client is told `sessionExpired` and disconnected.
import websocket from '@fastify/websocket';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import type { EngineClient } from '../engine/engine-client.js';
import type { OrderEntry } from '../orders/order-entry.js';
import type { GatewayServer } from '../server.js';
import type { SessionService } from '../session/session-service.js';
import {
  CLOSE_GOING_AWAY,
  CLOSE_POLICY_VIOLATION,
  CLOSE_TRY_AGAIN_LATER,
  ClientConnection,
  type ConnectionLimits,
} from './client-connection.js';
import type { SessionHub } from './session-hub.js';

export const WS_PATH = '/ws';

export interface WebSocketLimits extends ConnectionLimits {
  readonly allowedOrigins: readonly string[];
  readonly maxConnections: number;
  readonly maxConnectionsPerIp: number;
  readonly maxMessageBytes: number;
}

export interface WebSocketOptions {
  readonly sessions: Pick<SessionService, 'verify'>;
  readonly orderEntry: Pick<OrderEntry, 'placeOrder' | 'cancelOrder' | 'cancelAll'>;
  readonly hub: SessionHub<ClientConnection>;
  // For engineReset.
  readonly engine: Pick<EngineClient, 'on' | 'off'>;
  readonly limits: WebSocketLimits;
  readonly now?: () => number;
}

export function registerWebSocketRoute(server: GatewayServer, options: WebSocketOptions): void {
  const { hub, limits } = options;
  const allowedOrigins = new Set(limits.allowedOrigins);

  const onEngineReset = (): void => {
    if (hub.size === 0) return;
    server.log.warn({ connections: hub.size }, 'engine reset; closing client websockets');
    hub.closeAll(CLOSE_POLICY_VIOLATION, 'sessionExpired', {
      type: 'error',
      code: 'sessionExpired',
      message: 'The market was restarted; join again',
    });
  };
  options.engine.on('engineReset', onEngineReset);
  server.addHook('onClose', (_instance, done) => {
    options.engine.off('engineReset', onEngineReset);
    done();
  });

  // Refuses the upgrade when it would break a limit. Sends no body detail
  // beyond the reason: the client sees only the status.
  const admit = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (origin === undefined || !allowedOrigins.has(origin)) {
      request.log.info({ ip: request.ip }, 'websocket origin rejected');
      await reply.code(403).send({ error: 'originNotAllowed' });
      return;
    }
    if (hub.size >= limits.maxConnections) {
      request.log.warn({ connections: hub.size }, 'websocket connection cap reached');
      await reply.code(503).send({ error: 'tooManyConnections' });
      return;
    }
    if (hub.countForIp(request.ip) >= limits.maxConnectionsPerIp) {
      request.log.info({ ip: request.ip }, 'websocket per-IP cap reached');
      await reply.code(429).send({ error: 'tooManyConnections' });
    }
  };

  // Added before the plugin's own preClose hook, so clients see 1001 (going
  // away) rather than a close with no code.
  server.addHook('preClose', (done) => {
    hub.closeAll(CLOSE_GOING_AWAY, 'Server shutting down');
    done();
  });
  void server.register(websocket, { options: { maxPayload: limits.maxMessageBytes } });
  // Routes using { websocket: true } must be added once the plugin has loaded.
  void server.register((scope, _opts, done) => {
    scope.get(WS_PATH, { websocket: true, preValidation: admit }, (socket: WebSocket, request) => {
      // server.log, not request.log: the scope's request logger is typed as
      // Fastify's base logger rather than pino's.
      const log = server.log.child({ reqId: request.id, ip: request.ip });
      const connection = new ClientConnection(socket, request.ip, {
        sessions: options.sessions,
        orderEntry: options.orderEntry,
        hub,
        limits,
        logger: log,
        now: options.now ?? Date.now,
      });
      // Simultaneous upgrades can all pass `admit` before any is counted.
      if (
        hub.size > limits.maxConnections ||
        hub.countForIp(request.ip) > limits.maxConnectionsPerIp
      ) {
        connection.close(CLOSE_TRY_AGAIN_LATER, 'Too many connections');
      }
    });
    done();
  });
}
