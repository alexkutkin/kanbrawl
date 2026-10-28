import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { BoardStore } from './store.js';
import { SSEManager } from './sse.js';
import { createHttpApp, createMcpServer } from './index.js';

function createTestApp(options: { token?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-http-test-'));
  const store = new BoardStore(join(dir, 'kanbrawl.json'), { watch: false });
  const sse = new SSEManager();
  const app = createHttpApp(store, sse, createMcpServer(store), options);
  return { app, store, dir };
}

describe('HTTP transport guards', () => {
  let dir: string;
  let store: BoardStore;

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('without a token', () => {
    let app: ReturnType<typeof createTestApp>['app'];

    beforeEach(() => {
      ({ app, store, dir } = createTestApp());
    });

    it('serves the API to same-host calls', async () => {
      const res = await request(app).get('/api/board');
      expect(res.status).toBe(200);
    });

    it('rejects a foreign Origin on the MCP endpoint', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'http://evil.example')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ORIGIN_DENIED');
    });

    it('accepts a loopback Origin', async () => {
      const res = await request(app)
        .post('/mcp')
        .set('Origin', 'http://localhost:5173')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).not.toBe(403);
    });

    it('accepts requests without an Origin header', async () => {
      const res = await request(app)
        .post('/mcp')
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      expect(res.status).not.toBe(403);
    });
  });

  describe('with a token', () => {
    let app: ReturnType<typeof createTestApp>['app'];

    beforeEach(() => {
      ({ app, store, dir } = createTestApp({ token: 'secret' }));
    });

    it('rejects requests without the token', async () => {
      const res = await request(app).get('/api/board');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('accepts the token from a header or query parameter', async () => {
      const header = await request(app)
        .get('/api/board')
        .set('x-kanbrawl-token', 'secret');
      expect(header.status).toBe(200);

      const query = await request(app).get('/api/board?token=secret');
      expect(query.status).toBe(200);

      const wrong = await request(app)
        .get('/api/board')
        .set('x-kanbrawl-token', 'nope');
      expect(wrong.status).toBe(401);
    });

    it('redeems a query token into a cookie for the web UI', async () => {
      const agent = request.agent(app);
      const redeem = await agent.get('/?token=secret');
      expect(redeem.status).toBe(302);
      expect(redeem.headers.location).toBe('/');

      const board = await agent.get('/api/board');
      expect(board.status).toBe(200);
    });

    it('still rejects a foreign Origin before checking the token', async () => {
      const res = await request(app)
        .get('/api/board?token=secret')
        .set('Origin', 'http://evil.example');
      expect(res.status).toBe(403);
    });
  });
});
