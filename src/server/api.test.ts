import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { BoardStore } from './store.js';
import { createApiRouter } from './api.js';

const DEFAULT_COLUMN_NAMES = ['Todo', 'In progress', 'Blocked', 'Done'];

function pngBytes(seed = 0): Uint8Array {
  return Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    seed % 256,
    Math.floor(seed / 256) % 256,
  ]);
}

function createTestApp() {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-test-'));
  const filePath = join(dir, 'kanbrawl.db');
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
    testProjectId = undefined;
  });

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // Most tests just need a valid task; the project contract is covered by the
  // POST and PATCH project tests below. An explicit projectId is honored.
  let testProjectId: string | undefined;

  async function ensureTestProject(): Promise<string> {
    if (!testProjectId) {
      const res = await request(app)
        .put('/api/projects')
        .send({
          projects: [
            ...store.getProjects(),
            { name: 'Test project', folder: '' },
          ],
        });
      testProjectId = (res.body.projects as Array<{ id: string }>).at(-1)!.id;
    }

    return testProjectId;
  }

  async function postTask(body: Record<string, unknown>) {
    return request(app)
      .post('/api/tasks')
      .send({
        ...(body.projectId === undefined
          ? { projectId: await ensureTestProject() }
          : {}),
        ...body,
      });
  }

  // Emulates a task from before the project catalog (transitional state).
  function unclassify(taskId: string): void {
    const database = new DatabaseSync(join(dir, 'kanbrawl.db'));
    try {
      database
        .prepare('UPDATE tasks SET project_id = NULL WHERE id = ?')
        .run(taskId);
    } finally {
      database.close();
    }
  }

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
      expect(res.body.projects).toEqual([]);
      expect(res.body.projectsRevision).toBe(0);
      expect(res.body.tasks).toEqual([]);
    });
  });

  // --- POST /api/tasks ---
  describe('POST /api/tasks', () => {
    it('creates a task with minimal fields', async () => {
      const res = await postTask({ title: 'Test task' });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Test task');
      expect(res.body.column).toBe('Todo');
      expect(res.body.priority).toBe('P1');
      expect(res.body.lastActor).toBe('human');
      expect(res.body.id).toBeDefined();
    });

    it('creates a task with all fields and an explicit actor', async () => {
      const res = await postTask({
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
        .send({ title: 'Header actor', projectId: await ensureTestProject() });

      expect(res.status).toBe(201);
      expect(res.body.lastActor).toBe('web-ui');
    });

    it('rejects invalid titles with a code', async () => {
      const missing = await postTask({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('INVALID_TITLE');

      const blank = await postTask({ title: '   ' });
      expect(blank.status).toBe(400);
      expect(blank.body.code).toBe('INVALID_TITLE');

      const long = await postTask({ title: 'x'.repeat(201) });
      expect(long.status).toBe(400);
      expect(long.body.code).toBe('INVALID_TITLE');
    });

    it('rejects an invalid priority instead of storing it', async () => {
      const res = await postTask({ title: 'Task', priority: 'P9' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PRIORITY');
      expect(store.getTasks()).toHaveLength(0);
    });

    it('returns 404 for an unknown column', async () => {
      const res = await postTask({ title: 'Task', column: 'Nonexistent' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('COLUMN_NOT_FOUND');
      expect(res.body.details.availableColumns).toEqual(DEFAULT_COLUMN_NAMES);
    });

    it('returns the existing task for a repeated clientRequestId', async () => {
      const first = await postTask({ title: 'Once', clientRequestId: 'key-1' });
      const second = await postTask({
        title: 'Once again',
        clientRequestId: 'key-1',
      });

      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect(store.getTasks()).toHaveLength(1);
    });

    it('requires a project and returns it on the created task', async () => {
      const projectsResponse = await request(app)
        .put('/api/projects')
        .send({ projects: [{ name: 'Kanbrawl', folder: '' }] });
      const project = projectsResponse.body.projects[0];

      const missing = await request(app)
        .post('/api/tasks')
        .send({ title: 'Orphan' });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('INVALID_PROJECT');

      const unknown = await request(app).post('/api/tasks').send({
        title: 'Orphan',
        projectId: '00000000-0000-0000-0000-000000000000',
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('PROJECT_NOT_FOUND');

      const created = await request(app)
        .post('/api/tasks')
        .send({ title: 'Owned', projectId: project.id });
      expect(created.status).toBe(201);
      expect(created.body.projectId).toBe(project.id);
    });
  });

  // --- PATCH /api/tasks/:id ---
  describe('PATCH /api/tasks/:id', () => {
    it('updates and moves in one request', async () => {
      const created = await postTask({ title: 'Task' });

      const res = await request(app)
        .patch(`/api/tasks/${created.body.id}`)
        .send({ column: 'In progress', title: 'Renamed', assignee: 'bob' });

      expect(res.status).toBe(200);
      expect(res.body.column).toBe('In progress');
      expect(res.body.title).toBe('Renamed');
      expect(res.body.assignee).toBe('bob');
    });

    it('returns 409 for a stale expectedUpdatedAt', async () => {
      const created = await postTask({ title: 'Task' });

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
      const created = await postTask({ title: 'Task' });

      const res = await request(app)
        .patch(`/api/tasks/${created.body.id}`)
        .send({ column: 'Nonexistent' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('COLUMN_NOT_FOUND');
    });

    it('keeps the project when omitted and rejects null or unknown ids', async () => {
      const created = await postTask({ title: 'Owned' });
      const url = `/api/tasks/${created.body.id}`;

      const renamed = await request(app).patch(url).send({ title: 'Renamed' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.projectId).toBe(created.body.projectId);

      const nulled = await request(app).patch(url).send({ projectId: null });
      expect(nulled.status).toBe(400);
      expect(nulled.body.code).toBe('INVALID_PROJECT');

      const unknown = await request(app)
        .patch(url)
        .send({ projectId: '00000000-0000-0000-0000-000000000000' });
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('PROJECT_NOT_FOUND');
    });

    it('requires a project when editing a task without one', async () => {
      const projectId = await ensureTestProject();
      const created = await postTask({ title: 'Legacy' });
      unclassify(created.body.id);
      const url = `/api/tasks/${created.body.id}`;

      const edit = await request(app).patch(url).send({ title: 'Renamed' });
      expect(edit.status).toBe(400);
      expect(edit.body.code).toBe('INVALID_PROJECT');

      const classified = await request(app)
        .patch(url)
        .send({ title: 'Renamed', projectId });
      expect(classified.status).toBe(200);
      expect(classified.body.projectId).toBe(projectId);
    });

    it('moves between columns without touching the project', async () => {
      const created = await postTask({ title: 'Movable' });
      const url = `/api/tasks/${created.body.id}`;

      const moved = await request(app).patch(url).send({ column: 'Done' });
      expect(moved.status).toBe(200);
      expect(moved.body.column).toBe('Done');
      expect(moved.body.projectId).toBe(created.body.projectId);

      // A move is project-neutral: also a task without a project can move.
      unclassify(created.body.id);
      const movedLegacy = await request(app)
        .patch(url)
        .send({ column: 'Blocked' });
      expect(movedLegacy.status).toBe(200);
      expect(movedLegacy.body.column).toBe('Blocked');
      expect(movedLegacy.body.projectId).toBeUndefined();
    });
  });

  // --- DELETE /api/tasks/:id ---
  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task', async () => {
      const created = await postTask({ title: 'To delete' });

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
      const task = await postTask({ title: 'Stays', column: 'Blocked' });
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
      const task = await postTask({ title: 'Blocked task', column: 'Blocked' });
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

  // --- PUT /api/projects ---
  describe('PUT /api/projects', () => {
    it('creates, renames, reorders and deletes in full-list replacements', async () => {
      const created = await request(app)
        .put('/api/projects')
        .send({
          projects: [
            { name: 'Kanbrawl', folder: '/code/kanbrawl' },
            { name: 'Ops', folder: '/code/ops' },
          ],
        });

      expect(created.status).toBe(200);
      expect(created.body.revision).toBe(1);
      expect(created.body.projects).toHaveLength(2);
      expect(created.body.projects[0]).toMatchObject({
        name: 'Kanbrawl',
        folder: '/code/kanbrawl',
      });
      const [first, second] = created.body.projects;

      const updated = await request(app)
        .put('/api/projects')
        .send({
          projects: [
            { id: second.id, name: 'Runbook', folder: '/code/runbook' },
            { id: first.id, name: 'Kanbrawl', folder: '/code/kanbrawl' },
          ],
        });

      expect(updated.status).toBe(200);
      expect(updated.body.revision).toBe(2);
      expect(updated.body.projects).toEqual([
        { id: second.id, name: 'Runbook', folder: '/code/runbook' },
        { id: first.id, name: 'Kanbrawl', folder: '/code/kanbrawl' },
      ]);

      const board = await request(app).get('/api/board');
      expect(board.body.projects).toEqual(updated.body.projects);
      expect(board.body.projectsRevision).toBe(2);
    });

    it('allows an empty project list', async () => {
      const res = await request(app)
        .put('/api/projects')
        .send({ projects: [] });

      expect(res.status).toBe(200);
      expect(res.body.projects).toEqual([]);
      expect(res.body.revision).toBe(1);
    });

    it('returns 400 when projects is not an array', async () => {
      const res = await request(app)
        .put('/api/projects')
        .send({ projects: 'not-an-array' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PROJECTS');

      const missing = await request(app).put('/api/projects').send({});
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('INVALID_PROJECTS');
    });

    it('returns 409 for duplicate project names', async () => {
      const res = await request(app)
        .put('/api/projects')
        .send({
          projects: [
            { name: 'Kanbrawl', folder: '/a' },
            { name: 'Kanbrawl', folder: '/b' },
          ],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_PROJECT');
    });

    it('returns 409 CONFLICT for a stale expectedRevision', async () => {
      await request(app)
        .put('/api/projects')
        .send({ projects: [{ name: 'Kanbrawl', folder: '' }] });

      const res = await request(app)
        .put('/api/projects')
        .send({
          projects: [{ name: 'Overwritten', folder: '' }],
          expectedRevision: 0,
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
      expect(res.body.details.currentRevision).toBe(1);
      expect(
        res.body.details.projects.map((p: { name: string }) => p.name),
      ).toEqual(['Kanbrawl']);
    });

    it('accepts a matching expectedRevision', async () => {
      await request(app)
        .put('/api/projects')
        .send({ projects: [{ name: 'Kanbrawl', folder: '' }] });

      const res = await request(app)
        .put('/api/projects')
        .send({
          projects: [{ name: 'Guarded', folder: '' }],
          expectedRevision: 1,
        });

      expect(res.status).toBe(200);
      expect(res.body.revision).toBe(2);
    });

    it('rolls back the whole change when one item is rejected', async () => {
      await request(app)
        .put('/api/projects')
        .send({ projects: [{ name: 'Kanbrawl', folder: '/a' }] });

      const res = await request(app)
        .put('/api/projects')
        .send({
          projects: [
            { name: 'Renamed', folder: '/a' },
            { name: 'Renamed', folder: '/b' },
          ],
        });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_PROJECT');

      const board = await request(app).get('/api/board');
      expect(board.body.projects.map((p: { name: string }) => p.name)).toEqual([
        'Kanbrawl',
      ]);
      expect(board.body.projectsRevision).toBe(1);
    });

    it('returns 409 PROJECT_NOT_EMPTY with counts for a busy project', async () => {
      const created = await request(app)
        .put('/api/projects')
        .send({ projects: [{ name: 'Holds tasks', folder: '' }] });
      const project = created.body.projects[0];

      await postTask({
        title: 'Referencing task',
        projectId: project.id,
      });

      const res = await request(app)
        .put('/api/projects')
        .send({ projects: [] });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PROJECT_NOT_EMPTY');
      expect(res.body.details).toEqual({
        projectId: project.id,
        taskCount: 1,
      });
    });
  });

  // --- task attachments ---
  describe('task attachments', () => {
    async function createTask(title: string): Promise<string> {
      const res = await postTask({ title });
      return res.body.id as string;
    }

    function upload(taskId: string, body: Uint8Array, filename?: string) {
      const req = request(app)
        .post(`/api/tasks/${taskId}/attachments`)
        .set('Content-Type', 'application/octet-stream');
      return (filename === undefined ? req : req.query({ filename })).send(
        Buffer.from(body),
      );
    }

    it('uploads an image and serves it back with safe headers', async () => {
      const taskId = await createTask('With image');
      const bytes = pngBytes(1);

      const uploaded = await upload(taskId, bytes, 'shot.png');
      expect(uploaded.status).toBe(201);
      expect(uploaded.body).toMatchObject({
        taskId,
        filename: 'shot.png',
        mimeType: 'image/png',
        size: bytes.length,
      });
      expect(uploaded.headers['content-location']).toBe(
        `/api/attachments/${uploaded.body.id}`,
      );

      const sha256 = createHash('sha256').update(bytes).digest('hex');
      expect(uploaded.body.sha256).toBe(sha256);

      const served = await request(app).get(
        `/api/attachments/${uploaded.body.id}`,
      );
      expect(served.status).toBe(200);
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.headers.etag).toBe(`"${sha256}"`);
      expect(served.headers['x-content-type-options']).toBe('nosniff');
      expect(served.headers['content-security-policy']).toBe(
        "default-src 'none'; sandbox",
      );
      expect(served.headers['cache-control']).toContain('immutable');
      expect(Buffer.from(served.body).equals(Buffer.from(bytes))).toBe(true);

      const cached = await request(app)
        .get(`/api/attachments/${uploaded.body.id}`)
        .set('If-None-Match', `"${sha256}"`);
      expect(cached.status).toBe(304);
    });

    it('lists the attachment on the task and deletes it', async () => {
      const taskId = await createTask('Lifecycle');
      const uploaded = await upload(taskId, pngBytes(2));
      const attachmentId = uploaded.body.id as string;

      const board = await request(app).get('/api/board');
      expect(board.body.tasks[0].attachments).toHaveLength(1);

      const deleted = await request(app).delete(
        `/api/attachments/${attachmentId}`,
      );
      expect(deleted.status).toBe(204);

      const gone = await request(app).get(`/api/attachments/${attachmentId}`);
      expect(gone.status).toBe(404);
      expect(gone.body.code).toBe('ATTACHMENT_NOT_FOUND');

      const boardAfter = await request(app).get('/api/board');
      expect(boardAfter.body.tasks[0].attachments).toEqual([]);
    });

    it('returns the existing attachment for duplicate bytes', async () => {
      const taskId = await createTask('Deduped');
      const first = await upload(taskId, pngBytes(3));
      const second = await upload(taskId, pngBytes(3));
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);

      const board = await request(app).get('/api/board');
      expect(board.body.tasks[0].attachments).toHaveLength(1);
    });

    it('rejects non-image bytes and unknown tasks', async () => {
      const taskId = await createTask('Bad uploads');

      const notAnImage = await upload(taskId, Buffer.from('not an image'));
      expect(notAnImage.status).toBe(415);
      expect(notAnImage.body.code).toBe('INVALID_ATTACHMENT');

      const unknownTask = await upload('nope', pngBytes(4));
      expect(unknownTask.status).toBe(404);
      expect(unknownTask.body.code).toBe('TASK_NOT_FOUND');

      const unknownAttachment = await request(app).get('/api/attachments/nope');
      expect(unknownAttachment.status).toBe(404);
    });
  });
});
