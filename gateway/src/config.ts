// Gateway configuration, read from environment variables and validated once at
// startup. Errors name the offending variables but never echo their values,
// so a misconfigured SESSION_SECRET cannot end up in logs.
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const port = z.coerce.number().int().min(1).max(65535);
const positiveInt = z.coerce.number().int().positive();

const envSchema = z.object({
  PORT: port.default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  ENGINE_HOST: z.string().min(1).default('127.0.0.1'),
  ENGINE_PORT: port.default(7001),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
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
    limits: {
      maxSessions: e.MAX_SESSIONS,
      maxOpenOrdersPerSession: e.MAX_OPEN_ORDERS_PER_SESSION,
      maxOrdersPerSecond: e.MAX_ORDERS_PER_SECOND,
      maxWsMessageBytes: e.MAX_WS_MESSAGE_BYTES,
    },
  };
}
