// Gateway entry point: reads configuration from the environment, connects to
// the engine service and serves HTTP until SIGINT or SIGTERM.
import { ConfigError, loadConfig, type GatewayConfig } from './config.js';
import { EngineClient } from './engine/engine-client.js';
import { createLogger } from './logger.js';
import { MarketData } from './market/market-data.js';
import { buildServer } from './server.js';
import { SlidingWindowRateLimiter } from './session/rate-limiter.js';
import { SessionService } from './session/session-service.js';
import { TraderIdRegistry } from './session/trader-ids.js';

const SHUTDOWN_GRACE_MS = 10_000;

function readConfig(): GatewayConfig {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel);

  const engine = new EngineClient({
    host: config.engineHost,
    port: config.enginePort,
    logger,
  });

  // Trader IDs the engine reports are known, so new sessions never reuse them.
  const traderIds = new TraderIdRegistry();
  engine.on('snapshot', (snapshot) => {
    traderIds.addSnapshot(snapshot);
  });
  engine.on('event', (event) => {
    traderIds.addEvent(event);
  });
  // Candles and daily stats, rebuilt on every snapshot.
  const marketData = new MarketData();
  engine.on('snapshot', (snapshot) => {
    marketData.applySnapshot(snapshot);
  });
  engine.on('event', (event) => {
    marketData.applyEvent(event);
  });
  const sessions = new SessionService({
    secret: config.sessionSecret,
    maxAgeMs: config.session.maxAgeMs,
    engineStatus: () => engine.status,
    traderIds,
  });

  const server = buildServer({
    logger,
    engineStatus: () => engine.status,
    trustProxy: config.trustProxy,
    sessions: {
      sessions,
      rateLimiter: new SlidingWindowRateLimiter({
        limit: config.session.rateLimitPerMinute,
        windowMs: 60_000,
      }),
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      logger.warn({ signal }, 'second signal, exiting immediately');
      process.exit(1);
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => {
      logger.error('graceful shutdown timed out');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    void Promise.all([server.close(), engine.stop()]).then(
      () => {
        logger.info('stopped');
        process.exit(0);
      },
      (error: unknown) => {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await server.listen({ host: config.host, port: config.port });
  engine.start();
}

main().catch((error: unknown) => {
  process.stderr.write(`gateway failed to start: ${String(error)}\n`);
  process.exit(1);
});
