// A load test for the WebSocket fan-out (not run in CI). Opens many
// connections against a running gateway and engine service, and reports the
// message rates they receive, the snapshot latency after auth, seq gaps and
// how connections closed.
//
//   npm run load-test -w @ome/gateway -- --connections 300 --sessions 30 --duration 30
//
// Options: --url (default http://127.0.0.1:8080), --origin (default
// http://localhost:5173, must be in WS_ALLOWED_ORIGINS), --connections,
// --sessions (connections are spread over them, like browser tabs),
// --duration (seconds) and --switch (fraction of connections that change
// candle interval every 5 seconds).
//
// Every connection comes from one IP, so start the gateway with its per-IP
// limits raised, for example:
//
//   $env:WS_MAX_CONNECTIONS = '1000'
//   $env:WS_MAX_CONNECTIONS_PER_IP = '1000'
//   $env:SESSION_RATE_LIMIT_PER_MINUTE = '1000'
//
// Run with Node 24, which strips the types itself. Tokens are never printed.
import { parseArgs } from 'node:util';

import WebSocket from 'ws';

const INTERVALS = ['5s', '15s', '1m', '5m'] as const;
const REPORT_EVERY_MS = 5000;

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:8080' },
    origin: { type: 'string', default: 'http://localhost:5173' },
    connections: { type: 'string', default: '300' },
    sessions: { type: 'string', default: '30' },
    duration: { type: 'string', default: '30' },
    switch: { type: 'string', default: '0.1' },
  },
});

const baseUrl = values.url.replace(/\/$/, '');
const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/ws`;
const connectionCount = positive('connections', values.connections);
const sessionCount = Math.min(positive('sessions', values.sessions), connectionCount);
const durationMs = positive('duration', values.duration) * 1000;
const switchFraction = Number(values.switch);

function positive(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`--${name} must be a positive integer\n`);
    process.exit(2);
  }
  return n;
}

interface Stats {
  messages: number;
  bytes: number;
  readonly byType: Map<string, number>;
  seqGaps: number;
  readonly snapshotLatencyMs: number[];
  readonly closes: Map<string, number>;
  open: number;
}

// Set once the test closes its own connections, which are then not counted.
let stopping = false;

const stats: Stats = {
  messages: 0,
  bytes: 0,
  byType: new Map(),
  seqGaps: 0,
  snapshotLatencyMs: [],
  closes: new Map(),
  open: 0,
};

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function join(i: number): Promise<string> {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `load ${String(i)}` }),
  });
  if (!response.ok) {
    throw new Error(
      `POST /api/session answered ${String(response.status)}` +
        (response.status === 429 ? ' (raise SESSION_RATE_LIMIT_PER_MINUTE)' : ''),
    );
  }
  const body = (await response.json()) as { token: string };
  return body.token;
}

function open(token: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl, { origin: values.origin });
    let lastSeq = 0;
    let authSentAt = 0;
    let gotSnapshot = false;
    socket.on('open', () => {
      stats.open += 1;
      authSentAt = performance.now();
      socket.send(JSON.stringify({ type: 'auth', token }));
      resolve(socket);
    });
    socket.on('message', (data: Buffer) => {
      stats.messages += 1;
      stats.bytes += data.length;
      const message = JSON.parse(data.toString('utf8')) as { type: string; seq: number };
      bump(stats.byType, message.type);
      if (message.seq !== lastSeq + 1) stats.seqGaps += 1;
      lastSeq = message.seq;
      if (message.type === 'snapshot' && !gotSnapshot) {
        gotSnapshot = true;
        stats.snapshotLatencyMs.push(performance.now() - authSentAt);
      }
    });
    socket.on('unexpected-response', (_request, response) => {
      bump(stats.closes, `HTTP ${String(response.statusCode)}`);
      resolve(socket);
    });
    socket.on('error', () => {
      // 'close' follows.
    });
    socket.on('close', (code) => {
      if (authSentAt > 0) stats.open -= 1;
      if (!stopping) bump(stats.closes, String(code));
    });
  });
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN;
}

async function main(): Promise<void> {
  process.stdout.write(`joining ${String(sessionCount)} sessions at ${baseUrl}\n`);
  const tokens: string[] = [];
  for (let i = 0; i < sessionCount; ++i) tokens.push(await join(i));

  process.stdout.write(`opening ${String(connectionCount)} connections to ${wsUrl}\n`);
  const sockets: WebSocket[] = [];
  for (let i = 0; i < connectionCount; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(i + 50, connectionCount); ++j) {
      batch.push(open(tokens[j % tokens.length] ?? ''));
    }
    sockets.push(...(await Promise.all(batch)));
  }
  const startedAt = performance.now();
  stats.messages = 0;
  stats.bytes = 0;
  stats.byType.clear();

  let lastMessages = 0;
  let lastBytes = 0;
  const report = setInterval(() => {
    const seconds = REPORT_EVERY_MS / 1000;
    const rate = (stats.messages - lastMessages) / seconds;
    const perConnection = stats.open > 0 ? rate / stats.open : 0;
    process.stdout.write(
      `open ${String(stats.open)}  ${rate.toFixed(0)} msg/s ` +
        `(${perConnection.toFixed(1)} per connection)  ` +
        `${((stats.bytes - lastBytes) / seconds / 1024).toFixed(0)} KiB/s\n`,
    );
    lastMessages = stats.messages;
    lastBytes = stats.bytes;
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN && Math.random() < switchFraction) {
        const interval = INTERVALS[Math.floor(Math.random() * INTERVALS.length)];
        socket.send(JSON.stringify({ type: 'setInterval', interval }));
      }
    }
  }, REPORT_EVERY_MS);

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  clearInterval(report);
  const elapsed = (performance.now() - startedAt) / 1000;
  const openAtEnd = stats.open;
  stopping = true;
  for (const socket of sockets) socket.close(1000);

  const latency = [...stats.snapshotLatencyMs].sort((a, b) => a - b);
  const lines = [
    '',
    `connections       ${String(connectionCount)} (${String(openAtEnd)} open at the end)`,
    `messages          ${String(stats.messages)} in ${elapsed.toFixed(1)} s: ` +
      `${(stats.messages / elapsed).toFixed(0)}/s, ` +
      `${(stats.messages / elapsed / Math.max(1, openAtEnd)).toFixed(1)}/s per connection`,
    `bytes             ${(stats.bytes / elapsed / 1024).toFixed(0)} KiB/s`,
    `by type (/s/conn) ${[...stats.byType]
      .map(([type, n]) => `${type} ${(n / elapsed / Math.max(1, openAtEnd)).toFixed(2)}`)
      .join(', ')}`,
    `snapshot latency p50 ${percentile(latency, 0.5).toFixed(1)} ms, ` +
      `p95 ${percentile(latency, 0.95).toFixed(1)} ms, ` +
      `max ${(latency.at(-1) ?? Number.NaN).toFixed(1)} ms`,
    `seq gaps          ${String(stats.seqGaps)}`,
    `closed by server ${[...stats.closes].map(([code, n]) => `${code} x${String(n)}`).join(', ') || 'none'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `load test failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
