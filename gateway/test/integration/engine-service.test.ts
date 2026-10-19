// Runs EngineClient against the real C++ engine_service. Skipped when the
// binary has not been built (as in the CI Node job). Set ENGINE_SERVICE_BIN to
// use a binary other than build/{debug,release}/engine-service/engine_service.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineClient, type LiveEvent } from '../../src/engine/engine-client.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const EXE = process.platform === 'win32' ? 'engine_service.exe' : 'engine_service';

function findBinary(): string | undefined {
  const fromEnv = process.env['ENGINE_SERVICE_BIN'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return ['debug', 'release']
    .map((preset) => join(REPO_ROOT, 'build', preset, 'engine-service', EXE))
    .find((path) => existsSync(path));
}

const binary = findBinary();

// Starts engine_service on a free port and resolves with the port it logs.
async function startEngine(path: string): Promise<{ process: ChildProcess; port: number }> {
  const args = ['--port', '0', '--instrument', join(REPO_ROOT, 'protocol', 'instrument.json')];
  // The simulator (and its --no-sim switch) arrives with P1-06.
  const usage = spawnSync(path, ['--help'], { encoding: 'utf8' }).stdout;
  if (usage.includes('--no-sim')) args.push('--no-sim');

  const child = spawn(path, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const port = await new Promise<number>((resolve, reject) => {
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      const match = /listening on [^\s:]+:(\d+)/.exec(stderr);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.on('exit', (code) => {
      reject(new Error(`engine_service exited with code ${String(code)}:\n${stderr}`));
    });
    child.on('error', reject);
  });
  return { process: child, port };
}

describe.skipIf(binary === undefined)('engine_service integration', () => {
  let engine: ChildProcess | undefined;
  let client: EngineClient | undefined;

  beforeAll(async () => {
    const started = await startEngine(binary ?? '');
    engine = started.process;
    client = new EngineClient({
      host: '127.0.0.1',
      port: started.port,
      logger: pino({ level: 'silent' }),
    });
    const snapshot = once(client, 'snapshot');
    client.start();
    await snapshot;
  });

  afterAll(async () => {
    await client?.stop();
    if (engine !== undefined && engine.exitCode === null) {
      const exited = once(engine, 'exit');
      engine.kill();
      await exited;
    }
  });

  it('matches two crossing orders and reports the trade', async () => {
    const c = client as EngineClient;
    const events: LiveEvent[] = [];
    c.on('event', (event) => events.push(event));

    const buy = await c.submit({ traderId: 1_000_000, side: 'buy', price: 14_250n, qty: 10n });
    expect(buy.type).toBe('orderAccepted');
    const sell = await c.submit({ traderId: 1_000_001, side: 'sell', price: 14_250n, qty: 10n });
    expect(sell.type).toBe('orderAccepted');

    // The trade follows the sell's OrderAccepted, possibly in a later read.
    const deadline = Date.now() + 2000;
    while (!events.some((event) => event.type === 'trade') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const trade = events.find((event) => event.type === 'trade');
    expect(trade).toMatchObject({
      makerOrderId: buy.orderId,
      takerOrderId: sell.orderId,
      buyerTraderId: 1_000_000,
      sellerTraderId: 1_000_001,
      price: 14_250n,
      qty: 10n,
      aggressorSide: 'sell',
    });
  });
});
