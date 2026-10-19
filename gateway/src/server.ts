// The gateway's HTTP server. For now it only serves the health check; the
// WebSocket endpoint arrives in P1-10.
import type { IncomingMessage, ServerResponse } from 'node:http';

import Fastify, { type FastifyInstance, type RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

import type { EngineStatus } from './engine/engine-client.js';

export interface ServerOptions {
  readonly logger: Logger;
  readonly engineStatus: () => EngineStatus;
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
  const server = Fastify({ loggerInstance: options.logger });

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

  return server;
}
