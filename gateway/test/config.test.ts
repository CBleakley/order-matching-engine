import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const SECRET = 'a-very-long-session-secret-of-40-chars!!';

describe('loadConfig', () => {
  it('applies defaults when only the secret is set', () => {
    expect(loadConfig({ SESSION_SECRET: SECRET })).toEqual({
      port: 8080,
      host: '0.0.0.0',
      engineHost: '127.0.0.1',
      enginePort: 7001,
      sessionSecret: SECRET,
      logLevel: 'info',
      trustProxy: [],
      session: { maxAgeMs: 7 * 24 * 60 * 60 * 1000, rateLimitPerMinute: 10 },
      limits: {
        maxSessions: 1000,
        maxOpenOrdersPerSession: 50,
        maxOrdersPerSecond: 10,
        orderBurst: 20,
        priceBandPercent: 10,
        maxWsMessageBytes: 4096,
      },
      ws: {
        allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
        maxConnections: 500,
        maxConnectionsPerIp: 5,
        authTimeoutMs: 5000,
        pingIntervalMs: 30_000,
        maxViolations: 5,
        flushIntervalMs: 100,
        maxBufferedBytes: 1024 * 1024,
        stallTimeoutMs: 5000,
      },
    });
  });

  it('reads and coerces every variable', () => {
    const config = loadConfig({
      SESSION_SECRET: SECRET,
      PORT: '9000',
      HOST: '127.0.0.1',
      ENGINE_HOST: 'engine',
      ENGINE_PORT: '7100',
      LOG_LEVEL: 'debug',
      TRUST_PROXY: ' 172.16.0.0/12, ::1 ,loopback,',
      SESSION_MAX_AGE_SECONDS: '3600',
      SESSION_RATE_LIMIT_PER_MINUTE: '3',
      MAX_SESSIONS: '5',
      MAX_OPEN_ORDERS_PER_SESSION: '6',
      MAX_ORDERS_PER_SECOND: '7',
      ORDER_BURST: '9',
      PRICE_BAND_PERCENT: '25',
      MAX_WS_MESSAGE_BYTES: '8',
      WS_ALLOWED_ORIGINS: 'https://nova.example.com, http://localhost:3000',
      WS_MAX_CONNECTIONS: '11',
      WS_MAX_CONNECTIONS_PER_IP: '2',
      WS_AUTH_TIMEOUT_MS: '1500',
      WS_PING_INTERVAL_MS: '2500',
      WS_MAX_VIOLATIONS: '3',
      WS_FLUSH_INTERVAL_MS: '250',
      WS_MAX_BUFFERED_BYTES: '65536',
      WS_STALL_TIMEOUT_MS: '2000',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      engineHost: 'engine',
      enginePort: 7100,
      logLevel: 'debug',
      trustProxy: ['172.16.0.0/12', '::1', 'loopback'],
      session: { maxAgeMs: 3_600_000, rateLimitPerMinute: 3 },
      limits: {
        maxSessions: 5,
        maxOpenOrdersPerSession: 6,
        maxOrdersPerSecond: 7,
        orderBurst: 9,
        priceBandPercent: 25,
        maxWsMessageBytes: 8,
      },
      ws: {
        allowedOrigins: ['https://nova.example.com', 'http://localhost:3000'],
        maxConnections: 11,
        maxConnectionsPerIp: 2,
        authTimeoutMs: 1500,
        pingIntervalMs: 2500,
        maxViolations: 3,
        flushIntervalMs: 250,
        maxBufferedBytes: 65536,
        stallTimeoutMs: 2000,
      },
    });
  });

  it('requires SESSION_SECRET', () => {
    expect(() => loadConfig({})).toThrow(/SESSION_SECRET/);
  });

  it('rejects a short secret without echoing it', () => {
    const shortSecret = 'hunter2-hunter2';
    let error: unknown;
    try {
      loadConfig({ SESSION_SECRET: shortSecret });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toMatch(/SESSION_SECRET: must be at least 32/);
    expect((error as ConfigError).message).not.toContain(shortSecret);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', 'http'],
    ['ENGINE_PORT', '1.5'],
    ['LOG_LEVEL', 'verbose'],
    ['MAX_SESSIONS', '0'],
    ['TRUST_PROXY', 'caddy'],
    ['SESSION_MAX_AGE_SECONDS', '0'],
    ['SESSION_RATE_LIMIT_PER_MINUTE', '-1'],
    ['PRICE_BAND_PERCENT', '101'],
    ['WS_ALLOWED_ORIGINS', 'localhost:5173'],
    ['WS_ALLOWED_ORIGINS', 'https://example.com/'],
    ['WS_ALLOWED_ORIGINS', 'https://example.com/app'],
    ['WS_ALLOWED_ORIGINS', 'ftp://example.com'],
    ['WS_MAX_CONNECTIONS_PER_IP', '0'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ SESSION_SECRET: SECRET, [name]: value })).toThrow(
      new RegExp(`^Invalid gateway configuration:\\n  ${name}: `),
    );
  });

  it('lists every problem at once', () => {
    expect(() => loadConfig({ PORT: 'x', LOG_LEVEL: 'loud' })).toThrow(
      /PORT[\s\S]*SESSION_SECRET[\s\S]*LOG_LEVEL|PORT[\s\S]*LOG_LEVEL[\s\S]*SESSION_SECRET/,
    );
  });
});
