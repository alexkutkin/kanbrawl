import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { BoardStore } from './store.js';
import { createApiRouter } from './api.js';

const DEFAULT_COLUMN_NAMES = ['Todo', 'In progress', 'Blocked', 'Done'];

function createTestApp() {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-test-'));
  const filePath = join(dir, 'kanbrawl.json');
  const store = new BoardStore(filePath, { watch: false });
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(store));
  return { app, store, dir };
}

describe('REST API', () => {
  let app: express.Express;
  let store: BoardStore;
  let dir: string;

  beforeEach(() => {
    ({ app, store, dir } = createTestApp());
  });

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- GET /api/board ---
  describe('GET /api/board', () => {
    it('returns default board with columns and empty tasks', async () => {
      const res = await request(app).get('/api/board');
      expect(res.status).toBe(200);
      expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual(
        DEFAULT_COLUMN_NAMES,
      );
      expect(
        res.body.columns.every((c: { id?: string }) => Boolean(c.id)),
      ).toBe(true);
      expect(res.body.tasks).toEqual([]);
    });
  });

  // --- POST /api/tasks ---
  describe('POST /api/tasks', () => {
    it('creates a task with minimal fields', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'Test task' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Test task');
      expect(res.body.column).toBe('Todo');
      expect(res.body.priority).toBe('P1');
      expect(res.body.lastActor).toBe('human');
      expect(res.body.id).toBeDefined();
    });

    it('creates a task with all fields and an explicit actor', async () => {
      const res = await request(app).post('/api/tasks').send({
        title: 'Full task',
        description: 'A detailed description',
        column: 'In progress',
        priority: 'P0',
        assignee: 'agent-1',
        actor: 'planner',
      });

      expect(res.status).toBe(201);
      expect(res.body.column).toBe('In progress');
      expect(res.body.priority).toBe('P0');
      expect(res.body.assignee).toBe('agent-1');
      expect(res.body.lastActor).toBe('planner');
    });

    it('accepts an actor from the x-kanbrawl-actor header', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .set('x-kanbrawl-actor', 'web-ui')
        .send({ title: 'Header actor' });

      expect(res.status).toBe(201);
      expect(res.body.lastActor).toBe('web-ui');
    });

    it('rejects invalid titles with a code', async () => {
      const missing = await request(app).post('/api/tasks').send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('INVALID_TITLE');

      const blank = await request(app)
        .post('/api/tasks')
        .send({ title: '   ' });
      expect(blank.status).toBe(400);
      expect(blank.body.code).toBe('INVALID_TITLE');

      const long = await request(app)
        .post('/api/tasks')
        .send({ title: 'x'.repeat(201) });
      expect(long.status).toBe(400);
      expect(long.body.code).toBe('INVALID_TITLE');
    });

    it('rejects an invalid priority instead of storing it', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'Task', priority: 'P9' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRIORITY');
      expect(store.getTasks()).toHaveLength(0);
    });

    it('returns 404 for an unknown column', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'Task', column: 'Nonexistent' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('COLUMN_NOT_FOUND');
      expect(res.body.details.availableColumns).toEqual(DEFAULT_COLUMN_NAMES);
    });

    it('returns the existing task for a repeated clientRequestId', async () => {
      const first = await request(app)
        .post('/api/tasks')
        .send({ title: 'Once', clientRequestId: 'key-1' });
      const second = await request(app)
        .post('/api/tasks')
        .send({ title: 'Once again', clientRequestId: 'key-1' });

      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(store.getTasks()).toHaveLength(1);
    });
  });

  // --- PATCH /api/tasks/:id ---
  describe('PATCH /api/tasks/:id', () => {
    it('updates and moves in one request', async () => {
      const created = await request(app)
        .post('/api/tasks')
        .send({ title: 'Task' });

      const res = await request(app)
        .patch(`/api/tasks/${created.body.id}`)
        .send({ column: 'In progress', title: 'Renamed', assignee: 'bob' });

      expect(res.status).toBe(200);
      expect(res.body.column).toBe('In progress');
      expect(res.body.title).toBe('Renamed');
      expect(res.body.assignee).toBe('bob');
    });

    it('returns 409 for a stale expectedUpdatedAt', async () => {
      const created = await request(app)
        .post('/api/tasks')
        .send({ title: 'Task' });

      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });

      await request(app)
        .patch(`/api/tasks/${created.body.id}`)
        .send({ title: 'First' });

      const stale = await request(app)
        .patch(`/api/tasks/${created.body.id}`)
        .send({
          title: 'Second',
          expectedUpdatedAt: created.body.updatedAt,
        });

      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('CONFLICT');
      expect(stale.body.details.current.title).toBe('First');
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app)
        .patch('/api/tasks/00000000-0000-0000-0000-000000000000')
        .send({ title: 'Nope' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TASK_NOT_FOUND');
    });

    it('returns 404 for an invalid column on move', async () => {
      const created = await request(app)
        .post('/api/tasks')
        .send({ title: 'Task' });

      const res = await request(app)
        .patch(`/api/tasks/${created.body.id}`)
        .send({ column: 'Nonexistent' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('COLUMN_NOT_FOUND');
    });
  });

  // --- DELETE /api/tasks/:id ---
  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task', async () => {
      const created = await request(app)
        .post('/api/tasks')
        .send({ title: 'To delete' });

      const res = await request(app).delete(`/api/tasks/${created.body.id}`);
      expect(res.status).toBe(204);

      const board = await request(app).get('/api/board');
      expect(board.body.tasks).toHaveLength(0);
    });

    it('returns 404 for non-existent task', async () => {
      const res = await request(app).delete(
        '/api/tasks/00000000-0000-0000-0000-000000000000',
      );

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('TASK_NOT_FOUND');
    });
  });

  // --- PUT /api/columns ---
  describe('PUT /api/columns', () => {
    it('renames a column without moving its tasks', async () => {
      const task = await request(app)
        .post('/api/tasks')
        .send({ title: 'Stays', column: 'Blocked' });
      const board = await request(app).get('/api/board');
      const columns = board.body.columns.map(
        (column: {
          id: string;
          name: string;
          sortBy: string;
          sortOrder: string;
        }) =>
          column.name === 'Blocked' ? { ...column, name: 'On hold' } : column,
      );

      const res = await request(app).put('/api/columns').send({ columns });
      expect(res.status).toBe(200);
      expect(res.body.columns.map((c: { name: string }) => c.name)).toEqual([
        'Todo',
        'In progress',
        'On hold',
        'Done',
      ]);

      const after = await request(app).get('/api/board');
      const moved = after.body.tasks.find(
        (item: { id: string }) => item.id === task.body.id,
      );
      expect(moved.column).toBe('On hold');
    });

    it('moves tasks from a removed column to moveTo', async () => {
      const task = await request(app)
        .post('/api/tasks')
        .send({ title: 'Blocked task', column: 'Blocked' });
      const board = await request(app).get('/api/board');
      const columns = board.body.columns.filter(
        (column: { name: string }) => column.name !== 'Blocked',
      );

      const res = await request(app)
        .put('/api/columns')
        .send({ columns, moveTo: 'Done' });
      expect(res.status).toBe(200);

      const after = await request(app).get('/api/board');
      const moved = after.body.tasks.find(
        (item: { id: string }) => item.id === task.body.id,
      );
      expect(moved.column).toBe('Done');
    });

    it('returns 409 for duplicate column names', async () => {
      const res = await request(app)
        .put('/api/columns')
        .send({
          columns: [
            { name: 'A', sortBy: 'created', sortOrder: 'asc' },
            { name: 'A', sortBy: 'created', sortOrder: 'asc' },
          ],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_COLUMN');
    });

    it('returns 400 when columns is not an array', async () => {
      const res = await request(app)
        .put('/api/columns')
        .send({ columns: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_COLUMNS');
    });

    it('returns 400 when columns is missing', async () => {
      const res = await request(app).put('/api/columns').send({});
      expect(res.status).toBe(400);
    });
  });
});
