import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import type { EngineStatus } from '../src/engine/engine-client.js';
import { buildServer, type GatewayServer } from '../src/server.js';

let server: GatewayServer | undefined;

function serverWith(status: EngineStatus): GatewayServer {
  server = buildServer({ logger: pino({ level: 'silent' }), engineStatus: () => status });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('GET /healthz', () => {
  it('reports ok with the engine instance when connected', async () => {
    const response = await serverWith({
      connected: true,
      ready: true,
      engineInstanceId: 18_446_744_073_709_551_615n,
    }).inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      engine: { connected: true, engineInstanceId: '18446744073709551615' },
    });
  });

  it('reports unavailable before the first connection', async () => {
    const response = await serverWith({
      connected: false,
      ready: false,
      engineInstanceId: undefined,
    }).inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      engine: { connected: false, engineInstanceId: null },
    });
  });

  it('keeps the last engine instance while disconnected', async () => {
    const response = await serverWith({
      connected: false,
      ready: false,
      engineInstanceId: 5n,
    }).inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ engine: { connected: false, engineInstanceId: '5' } });
  });
});
