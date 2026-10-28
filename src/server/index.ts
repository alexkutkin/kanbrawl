import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { BoardStore } from './store.js';
import { SSEManager } from './sse.js';
import { registerTools } from './tools.js';
import { createApiRouter } from './api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PORT = 8431;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TOKEN_COOKIE = 'kanbrawl_token';

async function isPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, host);
  });
}

async function findAvailablePort(
  preferred: number,
  host: string,
): Promise<number> {
  if (await isPortAvailable(preferred, host)) {
    return preferred;
  }

  // Let the OS assign a random available port
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
    server.listen(0, host);
  });
}

export function createMcpServer(store: BoardStore): McpServer {
  const mcpServer = new McpServer({
    name: 'kanbrawl-mcp-server',
    version: '1.0.0',
  });
  registerTools(mcpServer, store);
  return mcpServer;
}

export type ServerOptions = {
  stdio?: boolean;
  port?: number;
  host?: string;
  token?: string;
  allowOrigins?: string[];
  boardFile?: string;
};

function getLanUrls(port: number): string[] {
  const urls: string[] = [];
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const networkInterface of interfaces ?? []) {
      if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
        urls.push(`http://${networkInterface.address}:${port}`);
      }
    }
  }

  return urls;
}

function localAddresses(): Set<string> {
  const addresses = new Set<string>(LOOPBACK);
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const networkInterface of interfaces ?? []) {
      addresses.add(networkInterface.address);
    }
  }

  return addresses;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    if (!name) continue;
    cookies[name] = decodeURIComponent(part.slice(index + 1).trim());
  }

  return cookies;
}

function createOriginGuard(allowOrigins: string[]) {
  const allowedHosts = localAddresses();
  const extra = new Set(
    allowOrigins.map((origin) => origin.trim().replace(/\/$/, '')),
  );

  return (request: Request, res: Response, next: NextFunction): void => {
    const origin = request.get('origin');
    if (!origin) {
      next();
      return;
    }

    let originUrl: URL;
    try {
      originUrl = new URL(origin);
    } catch {
      res
        .status(403)
        .json({ error: 'Origin not allowed', code: 'ORIGIN_DENIED' });
      return;
    }

    const { hostname } = originUrl;
    const isLocalHost = allowedHosts.has(hostname);
    const isSameHost = originUrl.host === request.get('host');
    if (isLocalHost || isSameHost || extra.has(origin.replace(/\/$/, ''))) {
      next();
      return;
    }

    res.status(403).json({
      error: `Origin "${origin}" is not allowed. Start the server with --allow-origin to permit it.`,
      code: 'ORIGIN_DENIED',
    });
  };
}

function createTokenGuard(token: string | undefined) {
  return (request: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }

    const queryToken =
      typeof request.query.token === 'string' ? request.query.token : undefined;
    const provided =
      request.get('x-kanbrawl-token') ??
      queryToken ??
      parseCookies(request.headers.cookie)[TOKEN_COOKIE];

    if (provided !== token) {
      res.status(401).json({
        error: 'Missing or invalid Kanbrawl token.',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    if (
      queryToken &&
      request.method === 'GET' &&
      !request.path.startsWith('/api') &&
      !request.path.startsWith('/events')
    ) {
      res.cookie(TOKEN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
      });
      res.redirect(302, request.path);
      return;
    }

    next();
  };
}

function createHttpApp(
  store: BoardStore,
  sse: SSEManager,
  mcpServer: McpServer,
  options: { token?: string; allowOrigins?: string[] } = {},
): express.Express {
  const app = express();
  // Unauthenticated liveness probe for container health checks. It exposes no
  // board data, so it stays outside both the origin and token guards.
  app.get('/healthz', (_request, res) => {
    res.json({ status: 'ok' });
  });
  app.use(createOriginGuard(options.allowOrigins ?? []));
  app.use(createTokenGuard(options.token));
  app.use(express.json());

  // MCP Streamable HTTP endpoint
  app.post('/mcp', async (request, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', async () => transport.close());
    await mcpServer.connect(transport);
    await transport.handleRequest(request, res, request.body);
  });

  // SSE endpoint for live updates
  app.get('/events', (request, res) => {
    sse.addClient(res);

    // Send initial board state
    const board = store.getBoard();
    res.write(
      `event: board_sync\ndata: ${JSON.stringify({ type: 'board_sync', board })}\n\n`,
    );
  });

  // REST API for web UI
  app.use('/api', createApiRouter(store));

  // Serve static client files (production build)
  const clientDirectory = resolve(__dirname, '../../dist/client');
  if (existsSync(clientDirectory)) {
    app.use(express.static(clientDirectory));
    // SPA fallback
    app.get('/{*splat}', (_request, res) => {
      res.sendFile(resolve(clientDirectory, 'index.html'));
    });
  }

  return app;
}

export { createHttpApp };

export async function startServer(
  options: ServerOptions = {},
): Promise<Server | undefined> {
  const log = options.stdio
    ? console.error.bind(console)
    : console.log.bind(console);

  // --- Initialize core services ---
  const store = new BoardStore(options.boardFile);

  if (options.stdio) {
    // Stdio transport for AI tool integrations. No HTTP, no port, no LAN.
    const mcpServer = createMcpServer(store);
    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    return undefined;
  }

  const sse = new SSEManager();
  const mcpServer = createMcpServer(store);

  // Wire SSE to store events
  store.onChange((event) => {
    sse.broadcast(event);
  });

  const host =
    options.host ??
    process.env.KB_HOST ??
    (existsSync('/.dockerenv') ? '0.0.0.0' : '127.0.0.1');
  const isLoopbackHost = LOOPBACK.has(host);
  const allowOrigins = [
    ...(options.allowOrigins ?? []),
    ...(process.env.KB_ALLOW_ORIGINS ?? '').split(',').filter(Boolean),
  ];

  let token = options.token ?? process.env.KB_TOKEN;
  if (!token && !isLoopbackHost) {
    token = randomBytes(24).toString('base64url');
    log(
      '🔐 Binding to a network interface without a token; generated one for this run.',
    );
    log(`   Access token: ${token}`);
    log(
      '   Pass it as ?token=…, the x-kanbrawl-token header, or --token to keep it stable.',
    );
  }

  // --- Express App ---
  const app = createHttpApp(store, sse, mcpServer, { token, allowOrigins });
  const requestedPort =
    options.port ??
    Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const port = await findAvailablePort(requestedPort, host);
  if (port !== requestedPort) {
    log(`⚠️  Port ${requestedPort} is in use, using port ${port} instead`);
  }

  const server = app.listen(port, host, () => {
    log(`🥊 Kanbrawl server running on http://localhost:${port}`);
    log(`   MCP endpoint: http://localhost:${port}/mcp`);
    if (!isLoopbackHost) {
      // Inside a container these interfaces are container-internal, not LAN addresses
      if (!existsSync('/.dockerenv')) {
        for (const url of getLanUrls(port)) {
          log(`   Network: ${url}`);
        }
      }

      log(`   Bound to ${host}; token required: ${token ? 'yes' : 'no'}`);
    }

    log('   MCP transport: HTTP');
  });

  return server;
}
