// Gateway configuration, read from environment variables and validated once at
// startup. Errors name the offending variables but never echo their values,
// so a misconfigured SESSION_SECRET cannot end up in logs.
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();
// Comma-separated IP addresses, CIDR ranges or proxy-addr's named ranges
// (loopback, linklocal, uniquelocal). Empty means none.
const PROXY_ENTRY = /^(loopback|linklocal|uniquelocal|[0-9A-Fa-f.:]+(\/[0-9]{1,3})?)$/;
const proxyList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .refine((entries) => entries.every((entry) => PROXY_ENTRY.test(entry)), {
    message: 'must list IP addresses or CIDR ranges',
  });

// Comma-separated browser origins, each exactly scheme://host[:port] with no
// path or trailing slash, as browsers send them in the Origin header.
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .refine((entries) => entries.every(isOrigin), {
    message: 'must list origins such as https://example.com or http://localhost:5173',
  });

function isOrigin(entry: string): boolean {
  if (!URL.canParse(entry)) return false;
  const url = new URL(entry);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === entry;
}

const envSchema = z.object({
  PORT: port.default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  ENGINE_HOST: z.string().min(1).default('127.0.0.1'),
  ENGINE_PORT: port.default(7001),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  // Reverse proxies whose X-Forwarded-For is believed when they are the peer.
  TRUST_PROXY: proxyList.default([]),
  SESSION_MAX_AGE_SECONDS: positiveInt.default(7 * 24 * 60 * 60),
  SESSION_RATE_LIMIT_PER_MINUTE: positiveInt.default(10),
  // Not enforced yet.
  MAX_SESSIONS: positiveInt.default(1000),
  // Order entry, per session (shared by all of its connections).
  MAX_OPEN_ORDERS_PER_SESSION: positiveInt.default(50),
  MAX_ORDERS_PER_SECOND: positiveInt.default(10),
  ORDER_BURST: positiveInt.default(20),
  // Orders priced further than this from the last trade are rejected.
  PRICE_BAND_PERCENT: positiveInt.max(100).default(10),
  // WebSocket endpoint.
  MAX_WS_MESSAGE_BYTES: positiveInt.default(4096),
  WS_ALLOWED_ORIGINS: originList.default(['http://localhost:5173', 'http://127.0.0.1:5173']),
  WS_MAX_CONNECTIONS: positiveInt.default(500),
  WS_MAX_CONNECTIONS_PER_IP: positiveInt.default(5),
  WS_AUTH_TIMEOUT_MS: positiveInt.default(5000),
  WS_PING_INTERVAL_MS: positiveInt.default(30_000),
  WS_MAX_VIOLATIONS: positiveInt.default(5),
  // Market data fan-out and slow consumers.
  WS_FLUSH_INTERVAL_MS: positiveInt.default(100),
  WS_MAX_BUFFERED_BYTES: positiveInt.default(1024 * 1024),
  WS_STALL_TIMEOUT_MS: positiveInt.default(5000),
});

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly engineHost: string;
  readonly enginePort: number;
  readonly sessionSecret: string;
  readonly logLevel: LogLevel;
  readonly trustProxy: readonly string[];
  readonly session: {
    readonly maxAgeMs: number;
    readonly rateLimitPerMinute: number;
  };
  readonly limits: {
    readonly maxSessions: number;
    readonly maxOpenOrdersPerSession: number;
    readonly maxOrdersPerSecond: number;
    readonly orderBurst: number;
    readonly priceBandPercent: number;
    readonly maxWsMessageBytes: number;
  };
  readonly ws: {
    readonly allowedOrigins: readonly string[];
    readonly maxConnections: number;
    readonly maxConnectionsPerIp: number;
    readonly authTimeoutMs: number;
    readonly pingIntervalMs: number;
    // Bad messages tolerated on one connection before it is closed.
    readonly maxViolations: number;
    // How often coalesced market data is sent.
    readonly flushIntervalMs: number;
    // A connection with more than this queued gets no market data.
    readonly maxBufferedBytes: number;
    // A connection over maxBufferedBytes for this long is closed.
    readonly stallTimeoutMs: number;
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): GatewayConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Issue messages describe the constraint, not the input value.
    const problems = parsed.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid gateway configuration:\n${problems.join('\n')}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    host: e.HOST,
    engineHost: e.ENGINE_HOST,
    enginePort: e.ENGINE_PORT,
    sessionSecret: e.SESSION_SECRET,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    session: {
      maxAgeMs: e.SESSION_MAX_AGE_SECONDS * 1000,
      rateLimitPerMinute: e.SESSION_RATE_LIMIT_PER_MINUTE,
    },
    limits: {
      maxSessions: e.MAX_SESSIONS,
      maxOpenOrdersPerSession: e.MAX_OPEN_ORDERS_PER_SESSION,
      maxOrdersPerSecond: e.MAX_ORDERS_PER_SECOND,
      orderBurst: e.ORDER_BURST,
      priceBandPercent: e.PRICE_BAND_PERCENT,
      maxWsMessageBytes: e.MAX_WS_MESSAGE_BYTES,
    },
    ws: {
      allowedOrigins: e.WS_ALLOWED_ORIGINS,
      maxConnections: e.WS_MAX_CONNECTIONS,
      maxConnectionsPerIp: e.WS_MAX_CONNECTIONS_PER_IP,
      authTimeoutMs: e.WS_AUTH_TIMEOUT_MS,
      pingIntervalMs: e.WS_PING_INTERVAL_MS,
      maxViolations: e.WS_MAX_VIOLATIONS,
      flushIntervalMs: e.WS_FLUSH_INTERVAL_MS,
      maxBufferedBytes: e.WS_MAX_BUFFERED_BYTES,
      stallTimeoutMs: e.WS_STALL_TIMEOUT_MS,
    },
  };
}
