// The whole system on free local ports: engine_service, the gateway and the
// built web app. Each test starts its own stack and stops it afterwards, so
// tests never share market state.
//
// Prerequisites (the e2e scripts check them): a built engine_service (the
// Release preset, or ENGINE_SERVICE_BIN), and `npm run build` for the
// gateway and web app.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ManagedProcess } from './process.ts';
import { startWebServer, type WebServer } from './web-server.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const START_TIMEOUT_MS = 60_000;
const exe = process.platform === 'win32' ? '.exe' : '';

export interface StackOptions {
  // Run the market simulator, with this much backfilled history (e.g. "30m").
  // Without it the engine runs with --no-sim and the book starts empty.
  readonly simulatorWarmup?: string;
}

export function findEngineBinary(): string {
  const configured = process.env.ENGINE_SERVICE_BIN;
  if (configured !== undefined && configured !== '') return path.resolve(configured);
  for (const preset of ['release', 'debug']) {
    const candidate = path.join(
      REPO_ROOT,
      'build',
      preset,
      'engine-service',
      `engine_service${exe}`,
    );
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'engine_service not found: build the release preset (cmake --preset release; ' +
      'cmake --build --preset release) or set ENGINE_SERVICE_BIN',
  );
}

export function checkBuilt(): void {
  findEngineBinary();
  for (const file of ['gateway/dist/main.js', 'web/dist/index.html']) {
    if (!existsSync(path.join(REPO_ROOT, file))) {
      throw new Error(`${file} is missing: run npm run build first`);
    }
  }
}

export class Stack {
  readonly #options: StackOptions;
  readonly #engineBinary: string;
  // Fresh per stack and only ever passed in the gateway's environment.
  readonly #sessionSecret = randomBytes(32).toString('hex');
  readonly #gatewayPort: number;
  #enginePort = 0;
  #engine: ManagedProcess | null = null;
  #gateway: ManagedProcess | null = null;
  #web: WebServer | null = null;
  // Every process started, including stopped ones, for the logs.
  readonly #history: ManagedProcess[] = [];

  private constructor(options: StackOptions, gatewayPort: number) {
    this.#options = options;
    this.#engineBinary = findEngineBinary();
    this.#gatewayPort = gatewayPort;
  }

  // Starts everything. If any part fails to start, the rest is stopped.
  static async start(options: StackOptions = {}): Promise<Stack> {
    const stack = new Stack(options, await freePort());
    try {
      stack.#web = await startWebServer({
        root: path.join(REPO_ROOT, 'web', 'dist'),
        gatewayPort: stack.#gatewayPort,
      });
      await stack.startEngine();
      await stack.startGateway();
    } catch (error) {
      await stack.stop();
      throw error;
    }
    return stack;
  }

  // The web app's address.
  get url(): string {
    if (this.#web === null) throw new Error('stack not started');
    return `http://127.0.0.1:${String(this.#web.port)}`;
  }

  // The first start picks a free port; restarts reuse it, so the gateway
  // reconnects to the new process.
  async startEngine(): Promise<void> {
    if (this.#engine !== null) throw new Error('engine already running');
    const sim =
      this.#options.simulatorWarmup === undefined
        ? ['--no-sim']
        : ['--warmup', this.#options.simulatorWarmup];
    const engine = new ManagedProcess({
      name: 'engine',
      command: this.#engineBinary,
      args: [
        '--port',
        String(this.#enginePort),
        '--instrument',
        path.join(REPO_ROOT, 'protocol', 'instrument.json'),
        ...sim,
      ],
      cwd: REPO_ROOT,
    });
    this.#engine = engine;
    this.#history.push(engine);
    const match = await engine.waitForOutput(/listening on [^\s]+:(\d+)/, START_TIMEOUT_MS);
    this.#enginePort = Number(match[1]);
  }

  async stopEngine(): Promise<void> {
    await this.#engine?.stop();
    this.#engine = null;
  }

  // Resolves once the gateway reports the engine connected.
  async startGateway(): Promise<void> {
    if (this.#gateway !== null) throw new Error('gateway already running');
    if (this.#web === null) throw new Error('web server not started');
    const gateway = new ManagedProcess({
      name: 'gateway',
      command: process.execPath,
      args: [path.join(REPO_ROOT, 'gateway', 'dist', 'main.js')],
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(this.#gatewayPort),
        ENGINE_HOST: '127.0.0.1',
        ENGINE_PORT: String(this.#enginePort),
        SESSION_SECRET: this.#sessionSecret,
        LOG_LEVEL: 'info',
        WS_ALLOWED_ORIGINS: this.url,
        // Every browser in a test comes from 127.0.0.1.
        SESSION_RATE_LIMIT_PER_MINUTE: '1000',
        WS_MAX_CONNECTIONS_PER_IP: '100',
        MAX_ORDERS_PER_SECOND: '100',
        ORDER_BURST: '100',
      },
    });
    this.#gateway = gateway;
    this.#history.push(gateway);
    await this.waitForGatewayReady(gateway);
  }

  async stopGateway(): Promise<void> {
    await this.#gateway?.stop();
    this.#gateway = null;
  }

  // Stops everything that is running. Safe to call more than once.
  async stop(): Promise<void> {
    await Promise.all([this.stopGateway(), this.stopEngine()]);
    await this.#web?.close();
    this.#web = null;
  }

  // Each process's output, labelled, oldest process first.
  logs(): string {
    return this.#history.map((p) => `===== ${p.name} =====\n${p.log}`).join('\n');
  }

  private async waitForGatewayReady(gateway: ManagedProcess): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    const healthz = `http://127.0.0.1:${String(this.#gatewayPort)}/healthz`;
    while (Date.now() < deadline) {
      if (gateway.exited) throw new Error(`gateway exited:\n${gateway.log}`);
      try {
        const response = await fetch(healthz);
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('timed out waiting for the gateway to connect to the engine');
  }
}

// A port that was free a moment ago. Another process could take it before the
// gateway binds it, but on a test machine that is rare.
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
}
