import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { BoardStore } from './store.js';
import { SSEManager } from './sse.js';
import { createHttpApp, createMcpServer } from './index.js';

function createTestApp() {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-http-test-'));
  const store = new BoardStore(join(dir, 'kanbrawl.json'), { watch: false });
  const sse = new SSEManager();
  const app = createHttpApp(store, sse, createMcpServer(store));
  return { app, store, dir };
}

describe('HTTP origin guard', () => {
  let dir: string;
  let store: BoardStore;
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    ({ app, store, dir } = createTestApp());
  });

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
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
