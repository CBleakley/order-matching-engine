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
  // Limits enforced by later tickets.
  MAX_SESSIONS: positiveInt.default(1000),
  MAX_OPEN_ORDERS_PER_SESSION: positiveInt.default(50),
  MAX_ORDERS_PER_SECOND: positiveInt.default(10),
  MAX_WS_MESSAGE_BYTES: positiveInt.default(4096),
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
    readonly maxWsMessageBytes: number;
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
      maxWsMessageBytes: e.MAX_WS_MESSAGE_BYTES,
    },
  };
}
