import { Buffer } from 'node:buffer';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore } from './store.js';
import { registerTools } from './tools.js';

const DEFAULT_COLUMN_NAMES = ['Todo', 'In progress', 'Blocked', 'Done'];

function pngBytes(seed = 0): Uint8Array {
  return new Uint8Array([
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

async function createTestMcp() {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-mcp-test-'));
  const filePath = join(dir, 'kanbrawl.db');
  const store = new BoardStore(filePath, { watch: false });

  const mcpServer = new McpServer({
    name: 'kanbrawl-test',
    version: '1.0.0',
  });
  registerTools(mcpServer, store);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, store, dir, mcpServer };
}

async function callTool(
  client: Client,
  name: string,
  arguments_: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: arguments_ });
  const textContent = result.content as Array<{ type: string; text: string }>;
  const text = textContent[0]?.text ?? '';
  return {
    ...result,
    isError: 'isError' in result ? result.isError : undefined,
    text,
    json: () => JSON.parse(text),
    structured: result.structuredContent as Record<string, unknown> | undefined,
  };
}

describe('MCP Tools', () => {
  let client: Client;
  let store: BoardStore;
  let dir: string;
  let mcpServer: McpServer;

  beforeEach(async () => {
    ({ client, store, dir, mcpServer } = await createTestMcp());
    testProjectId = undefined;
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // Most tests just need a valid task; the project contract is covered by the
  // project tests below. An explicit projectId is honored.
  let testProjectId: string | undefined;

  async function ensureTestProject(): Promise<string> {
    if (!testProjectId) {
      const result = await callTool(client, 'update_projects', {
        projects: [
          ...store.getProjects(),
          { name: 'Test project', folder: '' },
        ],
      });
      const projects = result.json().projects as Array<{ id: string }>;
      testProjectId = projects.at(-1)!.id;
    }

    return testProjectId;
  }

  async function createTask(fields: Record<string, unknown>) {
    return callTool(client, 'create_task', {
      ...fields,
      projectId:
        fields.projectId === undefined
          ? await ensureTestProject()
          : fields.projectId,
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

  // --- get_columns ---
  describe('get_columns', () => {
    it('returns default columns with stable IDs and zero counts', async () => {
      const result = await callTool(client, 'get_columns');
      const data = result.json();

      expect(data.columns.map((c: { name: string }) => c.name)).toEqual(
        DEFAULT_COLUMN_NAMES,
      );
      expect(data.columns.every((c: { id?: string }) => Boolean(c.id))).toBe(
        true,
      );
      expect(data.columns[0]).toMatchObject({
        name: 'Todo',
        taskCount: 0,
        sortBy: 'priority',
        sortOrder: 'asc',
      });
      expect(result.structured).toEqual(data);
    });

    it('reflects task counts after creating tasks', async () => {
      await createTask({ title: 'Task 1' });
      await createTask({ title: 'Task 2' });
      await createTask({
        title: 'Task 3',
        column: 'Done',
      });

      const result = await callTool(client, 'get_columns');
      const data = result.json();
      expect(
        data.columns.find((c: { name: string }) => c.name === 'Todo').taskCount,
      ).toBe(2);
      expect(
        data.columns.find((c: { name: string }) => c.name === 'Done').taskCount,
      ).toBe(1);
    });
  });

  // --- get_task ---
  describe('get_task', () => {
    it('returns a task by id', async () => {
      const created = await createTask({
        title: 'Find me',
        description: 'Details',
      });
      const result = await callTool(client, 'get_task', {
        id: created.json().id,
      });
      expect(result.isError).toBeUndefined();
      expect(result.json().title).toBe('Find me');
      expect(result.json().description).toBe('Details');
    });

    it('returns a coded error for unknown ids', async () => {
      const result = await callTool(client, 'get_task', {
        id: '00000000-0000-0000-0000-000000000000',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/\[TASK_NOT_FOUND]/);
    });
  });

  // --- list_tasks ---
  describe('list_tasks', () => {
    it('returns an empty page with metadata when no tasks', async () => {
      const result = await callTool(client, 'list_tasks');
      expect(result.json()).toEqual({
        tasks: [],
        total: 0,
        hasMore: false,
        offset: 0,
      });
      expect(result.structured).toEqual(result.json());
    });

    it('lists tasks from every column by default', async () => {
      await createTask({ title: 'A' });
      await createTask({ title: 'B', column: 'Done' });

      const result = await callTool(client, 'list_tasks');
      const { tasks, total } = await result.json();
      expect(total).toBe(2);
      expect(tasks.map((t: { title: string }) => t.title).sort()).toEqual([
        'A',
        'B',
      ]);
    });

    it('lists tasks in a specific column', async () => {
      await createTask({ title: 'A' });
      await createTask({ title: 'B', column: 'Done' });

      const result = await callTool(client, 'list_tasks', { column: 'Done' });
      expect(result.json().tasks).toHaveLength(1);
      expect(result.json().tasks[0].title).toBe('B');
      expect(result.json().total).toBe(1);
    });

    it('reports total and hasMore instead of hiding tasks', async () => {
      for (let index = 0; index < 12; index++) {
        // eslint-disable-next-line no-await-in-loop
        await createTask({ title: `Task ${index}` });
      }

      const all = await callTool(client, 'list_tasks');
      expect(all.json().tasks).toHaveLength(12);
      expect(all.json().total).toBe(12);
      expect(all.json().hasMore).toBe(false);

      const page = await callTool(client, 'list_tasks', {
        max: 5,
        offset: 10,
      });
      expect(page.json().tasks).toHaveLength(2);
      expect(page.json().total).toBe(12);
      expect(page.json().hasMore).toBe(false);
      expect(page.json().offset).toBe(10);

      const firstPage = await callTool(client, 'list_tasks', { max: 5 });
      expect(firstPage.json().hasMore).toBe(true);
    });

    it('filters by priority and assignee', async () => {
      await createTask({
        title: 'Mine',
        priority: 'P0',
        assignee: 'Alice',
      });
      await createTask({
        title: 'Theirs',
        priority: 'P2',
        assignee: 'Bob',
      });

      const byPriority = await callTool(client, 'list_tasks', {
        priority: 'P0',
      });
      expect(
        byPriority.json().tasks.map((t: { title: string }) => t.title),
      ).toEqual(['Mine']);

      const byAssignee = await callTool(client, 'list_tasks', {
        assignee: 'alice',
      });
      expect(
        byAssignee.json().tasks.map((t: { title: string }) => t.title),
      ).toEqual(['Mine']);
    });

    it('returns a coded error for an unknown column', async () => {
      const result = await callTool(client, 'list_tasks', {
        column: 'Nonexistent',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/\[COLUMN_NOT_FOUND]/);
      expect(result.text).toMatch(/availableColumns/);
    });

    it('sorts by priority (P0 first) then by created date', async () => {
      await createTask({ title: 'Low', priority: 'P2' });
      await createTask({ title: 'High', priority: 'P0' });
      await createTask({
        title: 'Normal',
        priority: 'P1',
      });
      await createTask({
        title: 'High2',
        priority: 'P0',
        column: 'Done',
      });

      const result = await callTool(client, 'list_tasks', { max: 100 });
      const titles = result.json().tasks.map((t: { title: string }) => t.title);
      expect(titles).toEqual(['High', 'High2', 'Normal', 'Low']);
    });

    it('filters by project ids', async () => {
      const setup = await callTool(client, 'update_projects', {
        projects: [
          { name: 'Alpha', folder: '' },
          { name: 'Beta', folder: '' },
        ],
      });
      const [alpha, beta] = setup.json().projects as Array<{ id: string }>;
      await callTool(client, 'create_task', {
        title: 'A task',
        projectId: alpha.id,
      });
      await callTool(client, 'create_task', {
        title: 'B task',
        projectId: beta.id,
      });

      const byProject = await callTool(client, 'list_tasks', {
        projectIds: [alpha.id],
      });
      expect(byProject.isError).toBeUndefined();
      expect(
        byProject.json().tasks.map((t: { title: string }) => t.title),
      ).toEqual(['A task']);

      const both = await callTool(client, 'list_tasks', {
        projectIds: [alpha.id, beta.id],
      });
      expect(both.json().total).toBe(2);

      // An omitted filter means all projects.
      const all = await callTool(client, 'list_tasks');
      expect(all.json().total).toBe(2);
    });

    it('rejects an empty or unknown projectIds filter', async () => {
      await callTool(client, 'update_projects', {
        projects: [{ name: 'Alpha', folder: '' }],
      });

      const empty = await callTool(client, 'list_tasks', { projectIds: [] });
      expect(empty.isError).toBe(true);
      expect(empty.text).toMatch(/^Error \[INVALID_PROJECT]:/);

      const unknown = await callTool(client, 'list_tasks', {
        projectIds: ['00000000-0000-0000-0000-000000000000'],
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toMatch(/^Error \[PROJECT_NOT_FOUND]:/);
    });
  });

  // --- create_task ---
  describe('create_task', () => {
    it('creates a task with defaults and actor metadata', async () => {
      const result = await createTask({
        title: 'New task',
      });
      const task = result.json();

      expect(task.title).toBe('New task');
      expect(task.column).toBe('Todo');
      expect(task.priority).toBe('P1');
      expect(task.description).toBe('');
      expect(task.assignee).toBe('');
      expect(task.lastActor).toBe('');
      expect(task.id).toBeDefined();
      expect(result.structured).toEqual(task);
    });

    it('records the actor and hides the idempotency key', async () => {
      const result = await createTask({
        title: 'Full task',
        description: 'Details',
        column: 'In progress',
        priority: 'P0',
        assignee: 'agent-x',
        actor: 'agent-x',
        clientRequestId: 'request-1',
      });
      const task = result.json();

      expect(task.column).toBe('In progress');
      expect(task.lastActor).toBe('agent-x');
      expect(task.clientRequestId).toBeUndefined();
    });

    it('is idempotent for a repeated clientRequestId', async () => {
      const first = await createTask({
        title: 'Once',
        clientRequestId: 'key-1',
      });
      const second = await createTask({
        title: 'Once again',
        clientRequestId: 'key-1',
      });
      expect(second.json().id).toBe(first.json().id);
      expect(store.getTasks()).toHaveLength(1);
    });

    it('accepts 4000 description characters and rejects 4001', async () => {
      const description = 'x'.repeat(4000);
      const accepted = await createTask({
        title: 'At limit',
        description,
      });
      expect(accepted.isError).toBeUndefined();
      expect(accepted.json().description).toBe(description);

      const rejected = await createTask({
        title: 'Over limit',
        description: `${description}x`,
      });
      expect(rejected.isError).toBe(true);
      expect(store.getTasks()).toHaveLength(1);
    });

    it('returns a coded error for an unknown column', async () => {
      const result = await createTask({
        title: 'Task',
        column: 'Fake',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/\[COLUMN_NOT_FOUND]/);
    });

    it('requires a project and returns it on the created task', async () => {
      const setup = await callTool(client, 'update_projects', {
        projects: [{ name: 'Kanbrawl', folder: '' }],
      });
      const project = (setup.json().projects as Array<{ id: string }>)[0];

      const missing = await callTool(client, 'create_task', {
        title: 'Orphan',
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toMatch(/^Error \[INVALID_PROJECT]:/);

      const unknown = await callTool(client, 'create_task', {
        title: 'Orphan',
        projectId: '00000000-0000-0000-0000-000000000000',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toMatch(/^Error \[PROJECT_NOT_FOUND]:/);

      const created = await callTool(client, 'create_task', {
        title: 'Owned',
        projectId: project.id,
      });
      expect(created.isError).toBeUndefined();
      expect(created.json().projectId).toBe(project.id);
    });
  });

  // --- move_task ---
  describe('move_task', () => {
    it('moves a task and records the actor', async () => {
      const created = await createTask({
        title: 'Movable',
      });
      const result = await callTool(client, 'move_task', {
        id: created.json().id,
        column: 'Done',
        actor: 'mover',
      });
      expect(result.json().column).toBe('Done');
      expect(result.json().lastActor).toBe('mover');
    });

    it('rejects a stale expectedUpdatedAt with CONFLICT', async () => {
      const created = await createTask({ title: 'Task' });
      const stale = created.json().updatedAt as string;
      await new Promise((resolve) => {
        setTimeout(resolve, 2);
      });
      await callTool(client, 'update_task', {
        id: created.json().id,
        title: 'Changed',
      });

      const result = await callTool(client, 'move_task', {
        id: created.json().id,
        column: 'Done',
        expectedUpdatedAt: stale,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/\[CONFLICT]/);
      expect(store.getTasks()[0].column).toBe('Todo');
    });

    it('returns coded errors for unknown tasks and columns', async () => {
      const missing = await callTool(client, 'move_task', {
        id: '00000000-0000-0000-0000-000000000000',
        column: 'Done',
      });
      expect(missing.text).toMatch(/\[TASK_NOT_FOUND]/);

      const created = await createTask({ title: 'Task' });
      const badColumn = await callTool(client, 'move_task', {
        id: created.json().id,
        column: 'Nonexistent',
      });
      expect(badColumn.text).toMatch(/\[COLUMN_NOT_FOUND]/);
    });
  });

  // --- update_task ---
  describe('update_task', () => {
    it('updates fields and the column in one call', async () => {
      const created = await createTask({ title: 'Task' });
      const result = await callTool(client, 'update_task', {
        id: created.json().id,
        description: 'New desc',
        priority: 'P2',
        assignee: 'someone',
        column: 'Done',
        actor: 'editor',
      });
      const task = result.json();
      expect(task.description).toBe('New desc');
      expect(task.priority).toBe('P2');
      expect(task.assignee).toBe('someone');
      expect(task.column).toBe('Done');
      expect(task.lastActor).toBe('editor');
    });

    it('does not leave partial changes for an invalid column', async () => {
      const created = await createTask({ title: 'Task' });
      const result = await callTool(client, 'update_task', {
        id: created.json().id,
        title: 'Changed',
        column: 'Nonexistent',
      });
      expect(result.isError).toBe(true);
      expect(store.getTasks()[0].title).toBe('Task');
    });

    it('accepts 4000 description characters and rejects 4001', async () => {
      const created = await createTask({ title: 'Task' });
      const id = created.json().id as string;
      const description = 'x'.repeat(4000);
      const accepted = await callTool(client, 'update_task', {
        id,
        description,
      });
      expect(accepted.isError).toBeUndefined();
      expect(accepted.json().description).toBe(description);

      const rejected = await callTool(client, 'update_task', {
        id,
        description: `${description}x`,
      });
      expect(rejected.isError).toBe(true);
      expect(store.getTask(id)!.description).toBe(description);
    });

    it('returns a coded error for unknown ids', async () => {
      const result = await callTool(client, 'update_task', {
        id: '00000000-0000-0000-0000-000000000000',
        title: 'Nope',
      });
      expect(result.text).toMatch(/\[TASK_NOT_FOUND]/);
    });

    it('keeps the project when omitted and rejects null or unknown ids', async () => {
      const created = await createTask({ title: 'Owned' });
      const id = created.json().id as string;

      const renamed = await callTool(client, 'update_task', {
        id,
        title: 'Renamed',
      });
      expect(renamed.isError).toBeUndefined();
      expect(renamed.json().projectId).toBe(created.json().projectId);

      const nulled = await callTool(client, 'update_task', {
        id,
        projectId: null,
      });
      expect(nulled.isError).toBe(true);
      expect(nulled.text).toMatch(/^Error \[INVALID_PROJECT]:/);

      const unknown = await callTool(client, 'update_task', {
        id,
        projectId: '00000000-0000-0000-0000-000000000000',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toMatch(/^Error \[PROJECT_NOT_FOUND]:/);
    });

    it('requires a project when editing a task without one', async () => {
      const created = await createTask({ title: 'Legacy' });
      const id = created.json().id as string;
      unclassify(id);

      const edit = await callTool(client, 'update_task', {
        id,
        title: 'Renamed',
      });
      expect(edit.isError).toBe(true);
      expect(edit.text).toMatch(/^Error \[INVALID_PROJECT]:/);

      const projectId = await ensureTestProject();
      const classified = await callTool(client, 'update_task', {
        id,
        title: 'Renamed',
        projectId,
      });
      expect(classified.isError).toBeUndefined();
      expect(classified.json().projectId).toBe(projectId);
    });
  });

  // --- delete_task ---
  describe('delete_task', () => {
    it('deletes a task', async () => {
      const created = await createTask({
        title: 'To delete',
      });
      const result = await callTool(client, 'delete_task', {
        id: created.json().id,
      });
      expect(result.isError).toBeUndefined();
      expect(result.structured).toHaveProperty('message');
      expect(store.getTasks()).toHaveLength(0);
    });

    it('returns a coded error for unknown ids', async () => {
      const result = await callTool(client, 'delete_task', {
        id: '00000000-0000-0000-0000-000000000000',
      });
      expect(result.text).toMatch(/\[TASK_NOT_FOUND]/);
    });
  });

  // --- get_projects ---
  describe('get_projects', () => {
    it('returns an empty catalog with revision 0', async () => {
      const result = await callTool(client, 'get_projects');
      expect(result.isError).toBeUndefined();
      expect(result.json()).toEqual({ projects: [], revision: 0 });
      expect(result.structured).toEqual(result.json());
    });

    it('reflects the managed project list', async () => {
      await callTool(client, 'update_projects', {
        projects: [{ name: 'Kanbrawl', folder: '/code/kanbrawl' }],
      });

      const result = await callTool(client, 'get_projects');
      expect(result.json().projects).toHaveLength(1);
      expect(result.json().projects[0]).toMatchObject({
        name: 'Kanbrawl',
        folder: '/code/kanbrawl',
      });
      expect(result.json().revision).toBe(1);
    });
  });

  // --- update_projects ---
  describe('update_projects', () => {
    it('creates, renames, reorders and deletes in full-list replacements', async () => {
      const created = await callTool(client, 'update_projects', {
        projects: [
          { name: 'Kanbrawl', folder: '/code/kanbrawl' },
          { name: 'Ops', folder: '/code/ops' },
        ],
      });
      expect(created.isError).toBeUndefined();
      expect(created.json().revision).toBe(1);
      const [first, second] = created.json().projects as Array<{
        id: string;
      }>;

      const updated = await callTool(client, 'update_projects', {
        projects: [{ id: second.id, name: 'Runbook', folder: '/code/runbook' }],
      });
      expect(updated.isError).toBeUndefined();
      expect(updated.json().revision).toBe(2);
      expect(updated.json().projects).toEqual([
        { id: second.id, name: 'Runbook', folder: '/code/runbook' },
      ]);
      expect(store.getProjects()).toEqual(updated.json().projects);
    });

    it('accepts an empty list', async () => {
      await callTool(client, 'update_projects', {
        projects: [{ name: 'Only', folder: '' }],
      });
      const result = await callTool(client, 'update_projects', {
        projects: [],
      });
      expect(result.isError).toBeUndefined();
      expect(result.json().projects).toEqual([]);
      expect(result.json().revision).toBe(2);
    });

    it('rejects a stale expectedRevision with CONFLICT', async () => {
      await callTool(client, 'update_projects', {
        projects: [{ name: 'Kanbrawl', folder: '' }],
      });

      const result = await callTool(client, 'update_projects', {
        projects: [{ name: 'Overwritten', folder: '' }],
        expectedRevision: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^Error \[CONFLICT]:/);
      expect(store.getProjects().map((project) => project.name)).toEqual([
        'Kanbrawl',
      ]);
    });

    it('rejects duplicate names with DUPLICATE_PROJECT', async () => {
      const result = await callTool(client, 'update_projects', {
        projects: [
          { name: 'Kanbrawl', folder: '/a' },
          { name: 'Kanbrawl', folder: '/b' },
        ],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^Error \[DUPLICATE_PROJECT]:/);
    });

    it('refuses to delete a project that still holds tasks', async () => {
      const created = await callTool(client, 'update_projects', {
        projects: [{ name: 'Holds tasks', folder: '' }],
      });
      const project = (created.json().projects as Array<{ id: string }>)[0];
      await callTool(client, 'create_task', {
        title: 'Referencing task',
        projectId: project.id,
      });

      const result = await callTool(client, 'update_projects', {
        projects: [],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^Error \[PROJECT_NOT_EMPTY]:/);
      expect(result.text).toContain(project.id);
      expect(result.text).toContain('"taskCount":1');
      expect(store.getProjects().map((item) => item.name)).toEqual([
        'Holds tasks',
      ]);
    });
  });

  // --- image attachments ---
  describe('image attachments', () => {
    it('attaches an image from a file path', async () => {
      const imagePath = join(dir, 'shot.png');
      writeFileSync(imagePath, pngBytes(1));
      const created = await createTask({
        title: 'With image',
      });
      const taskId = created.json().id as string;

      const result = await callTool(client, 'attach_image', {
        taskId,
        path: imagePath,
      });
      expect(result.isError).toBeUndefined();
      expect(result.json()).toMatchObject({
        taskId,
        filename: 'shot.png',
        mimeType: 'image/png',
        size: pngBytes(1).length,
      });
    });

    it('attaches an image from base64 data', async () => {
      const created = await createTask({
        title: 'Base64 image',
      });
      const taskId = created.json().id as string;

      const result = await callTool(client, 'attach_image', {
        taskId,
        data: Buffer.from(pngBytes(2)).toString('base64'),
        filename: 'pasted.png',
      });
      expect(result.isError).toBeUndefined();
      expect(result.json()).toMatchObject({
        taskId,
        filename: 'pasted.png',
        mimeType: 'image/png',
      });
    });

    it('lists attachment metadata in get_task and list_tasks', async () => {
      const created = await createTask({
        title: 'Annotated',
      });
      const taskId = created.json().id as string;
      await callTool(client, 'attach_image', {
        taskId,
        data: Buffer.from(pngBytes(3)).toString('base64'),
      });

      const task = await callTool(client, 'get_task', { id: taskId });
      const attachments = task.json().attachments as Array<{
        filename: string;
      }>;
      expect(attachments).toHaveLength(1);
      expect(attachments[0].filename).toBe('image.png');

      const listed = await callTool(client, 'list_tasks');
      expect(listed.json().tasks[0].attachments).toHaveLength(1);
    });

    it('returns metadata and image bytes with get_attachment', async () => {
      const created = await createTask({
        title: 'Fetch image',
      });
      const taskId = created.json().id as string;
      const attached = await callTool(client, 'attach_image', {
        taskId,
        data: Buffer.from(pngBytes(4)).toString('base64'),
      });
      const attachmentId = attached.json().id as string;

      const result = await callTool(client, 'get_attachment', { attachmentId });
      expect(result.isError).toBeUndefined();
      expect(result.json()).toMatchObject({
        id: attachmentId,
        taskId,
        mimeType: 'image/png',
      });

      const content = result.content as Array<{
        type: string;
        data?: string;
        mimeType?: string;
      }>;
      const image = content.find((block) => block.type === 'image');
      expect(image?.mimeType).toBe('image/png');
      expect(image?.data).toBe(Buffer.from(pngBytes(4)).toString('base64'));
    });

    it('deletes an attachment', async () => {
      const created = await createTask({
        title: 'Drop image',
      });
      const taskId = created.json().id as string;
      const attached = await callTool(client, 'attach_image', {
        taskId,
        data: Buffer.from(pngBytes(5)).toString('base64'),
      });
      const attachmentId = attached.json().id as string;

      const deleted = await callTool(client, 'delete_attachment', {
        attachmentId,
      });
      expect(deleted.isError).toBeUndefined();
      expect(deleted.json().message).toContain(attachmentId);

      const task = await callTool(client, 'get_task', { id: taskId });
      expect(task.json().attachments).toEqual([]);
    });

    it('reports stable errors for bad input', async () => {
      const created = await createTask({
        title: 'Errors',
      });
      const taskId = created.json().id as string;

      const noSource = await callTool(client, 'attach_image', { taskId });
      expect(noSource.isError).toBe(true);
      expect(noSource.text).toContain('Error [INVALID_ATTACHMENT]');

      const missingFile = await callTool(client, 'attach_image', {
        taskId,
        path: join(dir, 'missing.png'),
      });
      expect(missingFile.isError).toBe(true);
      expect(missingFile.text).toContain('Error [INVALID_ATTACHMENT]');

      const notAnImage = await callTool(client, 'attach_image', {
        taskId,
        data: Buffer.from('not an image').toString('base64'),
      });
      expect(notAnImage.isError).toBe(true);
      expect(notAnImage.text).toContain('Error [INVALID_ATTACHMENT]');

      const unknownTask = await callTool(client, 'attach_image', {
        taskId: 'nope',
        data: Buffer.from(pngBytes(6)).toString('base64'),
      });
      expect(unknownTask.isError).toBe(true);
      expect(unknownTask.text).toContain('Error [TASK_NOT_FOUND]');

      const unknownAttachment = await callTool(client, 'get_attachment', {
        attachmentId: 'nope',
      });
      expect(unknownAttachment.isError).toBe(true);
      expect(unknownAttachment.text).toContain('Error [ATTACHMENT_NOT_FOUND]');
    });
  });

  // --- tool discovery ---
  describe('tool discovery', () => {
    it('lists all registered tools', async () => {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'attach_image',
        'create_task',
        'delete_attachment',
        'delete_task',
        'get_attachment',
        'get_columns',
        'get_projects',
        'get_task',
        'list_tasks',
        'move_task',
        'update_projects',
        'update_task',
      ]);
    });

    it('publishes truthful annotations', async () => {
      const { tools } = await client.listTools();
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.get('get_task')?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });
      for (const name of ['move_task', 'update_task', 'delete_task']) {
        expect(byName.get(name)?.annotations?.idempotentHint).toBe(false);
      }

      expect(byName.get('get_attachment')?.annotations?.readOnlyHint).toBe(
        true,
      );
      expect(byName.get('get_projects')?.annotations?.readOnlyHint).toBe(true);
      expect(byName.get('update_projects')?.annotations?.destructiveHint).toBe(
        true,
      );
      expect(byName.get('update_projects')?.annotations?.idempotentHint).toBe(
        false,
      );
      expect(
        byName.get('delete_attachment')?.annotations?.destructiveHint,
      ).toBe(true);

      expect(byName.get('delete_task')?.description).not.toMatch(/errorneous/);
    });

    it('does not bake current column names into the tool list', async () => {
      await callTool(client, 'get_columns');
      const columns = store
        .getColumns()
        .map((column) =>
          column.name === 'Todo' ? { ...column, name: 'Backlog' } : column,
        );
      store.updateColumns(columns);

      const after = JSON.stringify(await client.listTools());
      expect(after).not.toContain('Todo');
      expect(after).not.toContain('Backlog');

      const listed = await callTool(client, 'list_tasks');
      expect(listed.isError).toBeUndefined();
      expect(listed.json().total).toBe(0);
    });

    it('keeps working after a column rename', async () => {
      const columns = store
        .getColumns()
        .map((column) =>
          column.name === 'Todo' ? { ...column, name: 'Backlog' } : column,
        );
      store.updateColumns(columns);

      const created = await createTask({
        title: 'After rename',
      });
      expect(created.isError).toBeUndefined();
      expect(created.json().column).toBe('Backlog');

      const listed = await callTool(client, 'list_tasks');
      expect(listed.json().tasks[0].title).toBe('After rename');
    });
  });
});
