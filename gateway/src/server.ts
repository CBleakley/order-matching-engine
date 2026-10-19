// The gateway's HTTP server: the health check and, when configured, the
// session endpoint. The WebSocket endpoint arrives in P1-10.
import type { IncomingMessage, ServerResponse } from 'node:http';

import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

import type { EngineStatus } from './engine/engine-client.js';
import { registerSessionRoutes, type SessionRoutesOptions } from './session/routes.js';

export interface ServerOptions {
  readonly logger: Logger;
  readonly engineStatus: () => EngineStatus;
  // Trusted reverse proxy addresses or CIDR ranges. When the peer is one of
  // them, request.ip is the right-most X-Forwarded-For entry that is not, so
  // entries a client prepends are ignored.
  readonly trustProxy?: readonly string[];
  // Serves POST /api/session when present.
  readonly sessions?: SessionRoutesOptions;
}

export interface HealthResponse {
  readonly status: 'ok' | 'unavailable';
  readonly engine: {
    readonly connected: boolean;
    // Decimal string: JSON has no 64-bit integers. Null before the first
    // connection.
    readonly engineInstanceId: string | null;
  };
}

export type GatewayServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  Logger
>;

export function buildServer(options: ServerOptions): GatewayServer {
  const server = Fastify({
    loggerInstance: options.logger,
    // Never `true`: that would take the left-most entry, which the client
    // controls.
    trustProxy:
      options.trustProxy !== undefined && options.trustProxy.length > 0
        ? options.trustProxy.join(',')
        : false,
  });

  server.get('/healthz', (_request, reply) => {
    const engine = options.engineStatus();
    const body: HealthResponse = {
      status: engine.connected ? 'ok' : 'unavailable',
      engine: {
        connected: engine.connected,
        engineInstanceId: engine.engineInstanceId?.toString() ?? null,
      },
    };
    return reply.code(engine.connected ? 200 : 503).send(body);
  });

  if (options.sessions !== undefined) {
    registerSessionRoutes(server, options.sessions);
  }

  return server;
}
