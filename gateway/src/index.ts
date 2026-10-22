// Public API of the gateway package. src/main.ts is the executable entry point.
export { ConfigError, loadConfig, type GatewayConfig, type LogLevel } from './config.js';
export { backoffDelay, type BackoffOptions } from './engine/backoff.js';
export * from './engine/engine-client.js';
export { createLogger, REDACTED_PATHS, type Logger } from './logger.js';
export * from './orders/order-entry.js';
export * from './orders/reject-mapping.js';
export * from './orders/trader-book.js';
export {
  buildServer,
  type GatewayServer,
  type HealthResponse,
  type ServerOptions,
} from './server.js';
export * from './session/token-bucket.js';
export * from './ws/client-connection.js';
export * from './ws/session-hub.js';
export * from './ws/ws-server.js';
