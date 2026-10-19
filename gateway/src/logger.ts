// Structured JSON logging. Known secret-bearing fields are redacted wherever
// they appear in a log object, as a safety net: code should not log secrets
// in the first place.
import { pino, type DestinationStream, type Logger } from 'pino';

import type { LogLevel } from './config.js';

export type { Logger } from 'pino';

export const REDACTED_PATHS = [
  'sessionSecret',
  '*.sessionSecret',
  'token',
  '*.token',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(level: LogLevel, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'gateway' },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
