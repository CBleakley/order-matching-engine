import { Writable } from 'node:stream';

import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import type { EngineStatus } from '../../src/engine/engine-client.js';
import { createLogger } from '../../src/logger.js';
import { buildServer, type GatewayServer } from '../../src/server.js';
import { SlidingWindowRateLimiter } from '../../src/session/rate-limiter.js';
import { SessionService } from '../../src/session/session-service.js';
import { TraderIdRegistry, type RandomInt } from '../../src/session/trader-ids.js';

const SECRET = 'a-very-long-session-secret-of-40-chars!!';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface Harness {
  readonly server: GatewayServer;
  readonly sessions: SessionService;
  readonly traderIds: TraderIdRegistry;
  engine: Pick<EngineStatus, 'connected' | 'engineInstanceId'>;
  now: number;
  readonly logs: string[];
}

let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function harness(options: { random?: RandomInt; trustProxy?: readonly string[] } = {}): Harness {
  const logs: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const traderIds = new TraderIdRegistry(options.random);
  const h: Omit<Harness, 'server' | 'sessions'> = {
    traderIds,
    engine: { connected: true, engineInstanceId: 42n },
    now: 1_760_000_000_000,
    logs,
  };
  const sessions = new SessionService({
    secret: SECRET,
    maxAgeMs: MAX_AGE_MS,
    engineStatus: () => h.engine,
    traderIds,
    now: () => h.now,
  });
  server = buildServer({
    logger: createLogger('trace', destination),
    engineStatus: () => ({ ...h.engine, ready: h.engine.connected }),
    trustProxy: options.trustProxy ?? [],
    sessions: {
      sessions,
      rateLimiter: new SlidingWindowRateLimiter({ limit: 10, windowMs: 60_000, now: () => h.now }),
    },
  });
  return Object.assign(h, { server, sessions });
}

function join(h: Harness, body: unknown, remoteAddress = '203.0.113.1') {
  return h.server.inject({
    method: 'POST',
    url: '/api/session',
    payload: body as Record<string, unknown>,
    remoteAddress,
  });
}

describe('POST /api/session', () => {
  it('issues a session whose token verifies', async () => {
    const h = harness();
    const response = await join(h, { name: '  Ada  ' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ token: string; traderId: number; name: string }>();
    expect(body).toEqual({
      token: expect.any(String) as string,
      traderId: body.traderId,
      name: 'Ada',
    });
    expect(Object.keys(body).sort()).toEqual(['name', 'token', 'traderId']);
    expect(body.traderId).toBeGreaterThanOrEqual(1_000_000);
    expect(body.traderId).toBeLessThan(2 ** 31);
    expect(h.sessions.verify(body.token)).toEqual({
      ok: true,
      claims: { traderId: body.traderId, name: 'Ada', engineInstanceId: 42n, issuedAt: h.now },
    });
  });

  it('never logs the token', async () => {
    const h = harness();
    const response = await join(h, { name: 'Ada' });
    const { token } = response.json<{ token: string }>();
    expect(h.logs.length).toBeGreaterThan(0);
    const [payload] = token.split('.') as [string];
    for (const line of h.logs) {
      expect(line).not.toContain(token);
      expect(line).not.toContain(payload);
    }
  });

  it('gives distinct trader IDs, re-drawing on collision', async () => {
    const values = [1_500_000, 1_500_000, 2_000_000, 2_500_000];
    const h = harness({ random: () => values.shift() ?? 0 });
    h.traderIds.add(2_000_000); // e.g. reported by the engine snapshot
    const first = (await join(h, { name: 'Ada' })).json<{ traderId: number }>();
    const second = (await join(h, { name: 'Ada' })).json<{ traderId: number }>();
    expect(first.traderId).toBe(1_500_000);
    expect(second.traderId).toBe(2_500_000);
  });

  it('answers 503 when no free trader ID can be drawn', async () => {
    const h = harness({ random: () => 1_500_000 });
    h.traderIds.add(1_500_000);
    const response = await join(h, { name: 'Ada' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'engineUnavailable' });
  });

  it.each([
    [{ name: 'a' }, 'Name must be 2–20 characters'],
    [{ name: 'hi!' }, 'Name may only contain letters, digits, spaces, - and _'],
    [{ name: 7 }, 'Name must be a string'],
    [{}, 'Request body must be a JSON object with a "name" field'],
    [['Ada'], 'Request body must be a JSON object with a "name" field'],
  ])('rejects %j with a clear message', async (body, message) => {
    const response = await join(harness(), body);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalidName', message });
  });

  it('rejects a non-JSON body', async () => {
    const h = harness();
    const response = await h.server.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an oversized body', async () => {
    const response = await join(harness(), { name: 'Ada', padding: 'x'.repeat(2000) });
    expect(response.statusCode).toBe(413);
  });

  it('answers 503 while the engine is disconnected', async () => {
    const h = harness();
    h.engine = { connected: false, engineInstanceId: undefined };
    expect((await join(h, { name: 'Ada' })).statusCode).toBe(503);
    h.engine = { connected: false, engineInstanceId: 42n };
    const response = await join(h, { name: 'Ada' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'engineUnavailable' });
  });

  it('rate-limits per IP', async () => {
    const h = harness();
    for (let i = 0; i < 10; ++i) {
      expect((await join(h, { name: 'Ada' })).statusCode).toBe(200);
      h.now += 1000;
    }
    const limited = await join(h, { name: 'Ada' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ error: 'rateLimited' });
    expect(limited.headers['retry-after']).toBe('50');

    // Other clients are unaffected.
    expect((await join(h, { name: 'Ada' }, '203.0.113.2')).statusCode).toBe(200);

    h.now += 50_000;
    expect((await join(h, { name: 'Ada' })).statusCode).toBe(200);
  });

  it('counts invalid requests towards the limit', async () => {
    const h = harness();
    for (let i = 0; i < 10; ++i) {
      expect((await join(h, { name: '!' })).statusCode).toBe(400);
    }
    expect((await join(h, { name: 'Ada' })).statusCode).toBe(429);
  });

  it('keys on X-Forwarded-For only when the peer is a trusted proxy', async () => {
    const send = (h: Harness, forwardedFor: string, remoteAddress = '10.0.0.1') =>
      h.server.inject({
        method: 'POST',
        url: '/api/session',
        payload: { name: 'Ada' },
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
      });

    const direct = harness();
    for (let i = 0; i < 10; ++i) {
      await send(direct, `198.51.100.${String(i)}`);
    }
    // Without trustProxy every request comes from the proxy's address.
    expect((await send(direct, '198.51.100.99')).statusCode).toBe(429);
    await direct.server.close();

    const proxied = harness({ trustProxy: ['10.0.0.0/8'] });
    for (let i = 0; i < 10; ++i) {
      expect((await send(proxied, '198.51.100.1')).statusCode).toBe(200);
    }
    expect((await send(proxied, '198.51.100.1')).statusCode).toBe(429);
    expect((await send(proxied, '198.51.100.2')).statusCode).toBe(200);
    // Only the entry the proxy appended counts; a client cannot prepend its way
    // past the limit.
    expect((await send(proxied, '192.0.2.77, 198.51.100.1')).statusCode).toBe(429);
    // A peer that is not a trusted proxy is keyed by its own address.
    for (let i = 0; i < 10; ++i) {
      await send(proxied, `192.0.2.${String(i)}`, '203.0.113.9');
    }
    expect((await send(proxied, '192.0.2.200', '203.0.113.9')).statusCode).toBe(429);
  });

  it('is not served when sessions are not configured', async () => {
    server = buildServer({
      logger: pino({ level: 'silent' }),
      engineStatus: () => ({ connected: true, ready: true, engineInstanceId: 1n }),
    });
    const response = await server.inject({
      method: 'POST',
      url: '/api/session',
      payload: { name: 'Ada' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('SessionService.verify', () => {
  it('rejects a token after the engine restarts', async () => {
    const h = harness();
    const { token } = (await join(h, { name: 'Ada' })).json<{ token: string }>();
    h.engine = { connected: true, engineInstanceId: 43n };
    expect(h.sessions.verify(token)).toEqual({ ok: false, reason: 'engineMismatch' });
  });

  it('still accepts a token while the same engine is briefly disconnected', async () => {
    const h = harness();
    const { token } = (await join(h, { name: 'Ada' })).json<{ token: string }>();
    h.engine = { connected: false, engineInstanceId: 42n };
    expect(h.sessions.verify(token).ok).toBe(true);
  });

  it('rejects an expired token', async () => {
    const h = harness();
    const { token } = (await join(h, { name: 'Ada' })).json<{ token: string }>();
    h.now += MAX_AGE_MS + 1;
    expect(h.sessions.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('records the trader ID of a verified token as known', async () => {
    const issuer = harness();
    const { token, traderId } = (await join(issuer, { name: 'Ada' })).json<{
      token: string;
      traderId: number;
    }>();
    // A gateway restarted with the same secret and engine knows nothing yet.
    const restarted = new TraderIdRegistry(() => traderId);
    const sessions = new SessionService({
      secret: SECRET,
      maxAgeMs: MAX_AGE_MS,
      engineStatus: () => ({ connected: true, engineInstanceId: 42n }),
      traderIds: restarted,
      now: () => issuer.now,
    });
    expect(restarted.has(traderId)).toBe(false);
    expect(sessions.verify(token).ok).toBe(true);
    expect(restarted.has(traderId)).toBe(true);
  });
});
