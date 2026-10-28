import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BoardStore } from './store.js';
import { registerTools } from './tools.js';

const DEFAULT_COLUMN_NAMES = ['Todo', 'In progress', 'Blocked', 'Done'];

async function createTestMcp() {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-mcp-test-'));
  const filePath = join(dir, 'kanbrawl.json');
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
  });

  afterEach(async () => {
    await client.close();
    await mcpServer.close();
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

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
      await callTool(client, 'create_task', { title: 'Task 1' });
      await callTool(client, 'create_task', { title: 'Task 2' });
      await callTool(client, 'create_task', {
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
      const created = await callTool(client, 'create_task', {
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
      await callTool(client, 'create_task', { title: 'A' });
      await callTool(client, 'create_task', { title: 'B', column: 'Done' });

      const result = await callTool(client, 'list_tasks');
      const { tasks, total } = await result.json();
      expect(total).toBe(2);
      expect(tasks.map((t: { title: string }) => t.title).sort()).toEqual([
        'A',
        'B',
      ]);
    });

    it('lists tasks in a specific column', async () => {
      await callTool(client, 'create_task', { title: 'A' });
      await callTool(client, 'create_task', { title: 'B', column: 'Done' });

      const result = await callTool(client, 'list_tasks', { column: 'Done' });
      expect(result.json().tasks).toHaveLength(1);
      expect(result.json().tasks[0].title).toBe('B');
      expect(result.json().total).toBe(1);
    });

    it('reports total and hasMore instead of hiding tasks', async () => {
      for (let index = 0; index < 12; index++) {
        // eslint-disable-next-line no-await-in-loop
        await callTool(client, 'create_task', { title: `Task ${index}` });
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
      await callTool(client, 'create_task', {
        title: 'Mine',
        priority: 'P0',
        assignee: 'Alice',
      });
      await callTool(client, 'create_task', {
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
      await callTool(client, 'create_task', { title: 'Low', priority: 'P2' });
      await callTool(client, 'create_task', { title: 'High', priority: 'P0' });
      await callTool(client, 'create_task', {
        title: 'Normal',
        priority: 'P1',
      });
      await callTool(client, 'create_task', {
        title: 'High2',
        priority: 'P0',
        column: 'Done',
      });

      const result = await callTool(client, 'list_tasks', { max: 100 });
      const titles = result.json().tasks.map((t: { title: string }) => t.title);
      expect(titles).toEqual(['High', 'High2', 'Normal', 'Low']);
    });
  });

  // --- create_task ---
  describe('create_task', () => {
    it('creates a task with defaults and actor metadata', async () => {
      const result = await callTool(client, 'create_task', {
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
      const result = await callTool(client, 'create_task', {
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
      const first = await callTool(client, 'create_task', {
        title: 'Once',
        clientRequestId: 'key-1',
      });
      const second = await callTool(client, 'create_task', {
        title: 'Once again',
        clientRequestId: 'key-1',
      });
      expect(second.json().id).toBe(first.json().id);
      expect(store.getTasks()).toHaveLength(1);
    });

    it('accepts 4000 description characters and rejects 4001', async () => {
      const description = 'x'.repeat(4000);
      const accepted = await callTool(client, 'create_task', {
        title: 'At limit',
        description,
      });
      expect(accepted.isError).toBeUndefined();
      expect(accepted.json().description).toBe(description);

      const rejected = await callTool(client, 'create_task', {
        title: 'Over limit',
        description: `${description}x`,
      });
      expect(rejected.isError).toBe(true);
      expect(store.getTasks()).toHaveLength(1);
    });

    it('returns a coded error for an unknown column', async () => {
      const result = await callTool(client, 'create_task', {
        title: 'Task',
        column: 'Fake',
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/\[COLUMN_NOT_FOUND]/);
    });
  });

  // --- move_task ---
  describe('move_task', () => {
    it('moves a task and records the actor', async () => {
      const created = await callTool(client, 'create_task', {
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
      const created = await callTool(client, 'create_task', { title: 'Task' });
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

      const created = await callTool(client, 'create_task', { title: 'Task' });
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
      const created = await callTool(client, 'create_task', { title: 'Task' });
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
      const created = await callTool(client, 'create_task', { title: 'Task' });
      const result = await callTool(client, 'update_task', {
        id: created.json().id,
        title: 'Changed',
        column: 'Nonexistent',
      });
      expect(result.isError).toBe(true);
      expect(store.getTasks()[0].title).toBe('Task');
    });

    it('accepts 4000 description characters and rejects 4001', async () => {
      const created = await callTool(client, 'create_task', { title: 'Task' });
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
  });

  // --- delete_task ---
  describe('delete_task', () => {
    it('deletes a task', async () => {
      const created = await callTool(client, 'create_task', {
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

  // --- tool discovery ---
  describe('tool discovery', () => {
    it('lists all registered tools', async () => {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        'create_task',
        'delete_task',
        'get_columns',
        'get_task',
        'list_tasks',
        'move_task',
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

      const created = await callTool(client, 'create_task', {
        title: 'After rename',
      });
      expect(created.isError).toBeUndefined();
      expect(created.json().column).toBe('Backlog');

      const listed = await callTool(client, 'list_tasks');
      expect(listed.json().tasks[0].title).toBe('After rename');
    });
  });
});
