// A child process the stack owns: its output is kept for the test report, a
// test can wait for a line of it, and stop() always leaves it dead. Anything
// still running when the test runner exits is killed then, so a crashed or
// interrupted run leaves no processes behind.
import { type ChildProcess, spawn } from 'node:child_process';

const STOP_GRACE_MS = 5000;
// Output kept per process, so a chatty process cannot use unbounded memory.
const MAX_LOG_CHARS = 1_000_000;

const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

export interface SpawnOptions {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

export class ManagedProcess {
  readonly name: string;
  readonly #child: ChildProcess;
  readonly #exited: Promise<void>;
  #log = '';
  #exitCode: number | null = null;
  #hasExited = false;
  readonly #lineWaiters = new Set<() => void>();

  constructor(options: SpawnOptions) {
    this.name = options.name;
    this.#child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    running.add(this.#child);
    const append = (chunk: Buffer): void => {
      this.#log += chunk.toString('utf8');
      if (this.#log.length > MAX_LOG_CHARS) this.#log = this.#log.slice(-MAX_LOG_CHARS);
      for (const wake of this.#lineWaiters) wake();
    };
    this.#child.stdout?.on('data', append);
    this.#child.stderr?.on('data', append);
    this.#exited = new Promise((resolve) => {
      const done = (code: number | null): void => {
        running.delete(this.#child);
        this.#hasExited = true;
        this.#exitCode = code;
        for (const wake of this.#lineWaiters) wake();
        resolve();
      };
      this.#child.once('exit', done);
      this.#child.once('error', (error) => {
        this.#log += `\n[spawn failed: ${error.message}]\n`;
        done(null);
      });
    });
  }

  get log(): string {
    return this.#log;
  }

  get exited(): boolean {
    return this.#hasExited;
  }

  // Resolves with the first match of `pattern` in the output so far or to
  // come. Rejects if the process exits first or `timeoutMs` passes.
  waitForOutput(pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, match?: RegExpMatchArray): void => {
        clearTimeout(timer);
        this.#lineWaiters.delete(check);
        if (error !== null) reject(error);
        else if (match !== undefined) resolve(match);
      };
      const check = (): void => {
        const match = pattern.exec(this.#log);
        if (match !== null) finish(null, match);
        else if (this.#hasExited) {
          finish(new Error(`${this.name} exited (code ${String(this.#exitCode)}):\n${this.#log}`));
        }
      };
      const timer = setTimeout(() => {
        finish(new Error(`timed out waiting for ${this.name} to print ${String(pattern)}`));
      }, timeoutMs);
      this.#lineWaiters.add(check);
      check();
    });
  }

  // SIGTERM, then SIGKILL if it is still running after a grace period. On
  // Windows both terminate the process at once.
  async stop(): Promise<void> {
    if (this.#hasExited) return;
    this.#child.kill('SIGTERM');
    const timer = setTimeout(() => {
      this.#child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    await this.#exited;
    clearTimeout(timer);
  }
}
