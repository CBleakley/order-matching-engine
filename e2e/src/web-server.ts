// Serves the built web app (web/dist) and forwards /api and /ws to the
// gateway, as Vite's dev proxy and the Caddy reverse proxy do. It runs inside
// the test process, so it goes away with the test.
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface WebServerOptions {
  readonly root: string;
  readonly gatewayPort: number;
}

export interface WebServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const root = path.resolve(options.root);
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket): void => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };

  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    if (url.startsWith('/api/') || url === '/healthz') {
      proxyRequest(request, response, options.gatewayPort);
    } else {
      void serveFile(root, url, response);
    }
  });
  server.on('connection', track);
  server.on('upgrade', (request: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (request.url !== '/ws') {
      socket.destroy();
      return;
    }
    // Replays the upgrade request to the gateway and then pipes raw bytes
    // both ways. If the gateway is down the browser sees the socket close.
    const upstream = net.connect(options.gatewayPort, '127.0.0.1', () => {
      const lines = [`${request.method ?? 'GET'} /ws HTTP/${request.httpVersion}`];
      for (let i = 0; i + 1 < request.rawHeaders.length; i += 2) {
        lines.push(`${request.rawHeaders[i] ?? ''}: ${request.rawHeaders[i + 1] ?? ''}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    track(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no web server address');

  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

function proxyRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  gatewayPort: number,
): void {
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: gatewayPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(upstream);
}

async function serveFile(root: string, url: string, response: http.ServerResponse): Promise<void> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  let file = path.resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    response.writeHead(404).end();
    return;
  }
  // Paths without an extension are app routes: serve the page.
  if (path.extname(file) === '') file = path.join(root, 'index.html');
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}
