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
      limits: {
        maxSessions: 1000,
        maxOpenOrdersPerSession: 50,
        maxOrdersPerSecond: 10,
        maxWsMessageBytes: 4096,
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
      MAX_SESSIONS: '5',
      MAX_OPEN_ORDERS_PER_SESSION: '6',
      MAX_ORDERS_PER_SECOND: '7',
      MAX_WS_MESSAGE_BYTES: '8',
    });
    expect(config).toMatchObject({
      port: 9000,
      host: '127.0.0.1',
      engineHost: 'engine',
      enginePort: 7100,
      logLevel: 'debug',
      limits: {
        maxSessions: 5,
        maxOpenOrdersPerSession: 6,
        maxOrdersPerSecond: 7,
        maxWsMessageBytes: 8,
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
