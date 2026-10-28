import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BoardEvent, Column } from '../shared/board.js';
import { BoardStore } from './store.js';
import { BoardError } from './errors.js';

const DEFAULT_COLUMN_NAMES = ['Todo', 'In progress', 'Blocked', 'Done'];

function createTestStore(watch = false) {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-store-test-'));
  const filePath = join(dir, 'kanbrawl.json');
  const store = new BoardStore(filePath, { watch });
  return { store, filePath, dir };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readBoard(filePath: string) {
  return JSON.parse(readFileSync(filePath, 'utf8')) as {
    columns: Column[];
    tasks: Array<{ title: string; column: string }>;
  };
}

describe('BoardStore', () => {
  let store: BoardStore;
  let filePath: string;
  let dir: string;

  beforeEach(() => {
    ({ store, filePath, dir } = createTestStore());
  });

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Initialization ---
  describe('initialization', () => {
    it('creates kanbrawl.json with defaults when file does not exist', () => {
      const data = readBoard(filePath);
      expect(data.columns.map((column) => column.name)).toEqual(
        DEFAULT_COLUMN_NAMES,
      );
      expect(data.columns.every((column) => Boolean(column.id))).toBe(true);
      expect(new Set(data.columns.map((column) => column.id)).size).toBe(4);
      expect(data.tasks).toEqual([]);
    });

    it('loads existing data from file', () => {
      const existingDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      const existingPath = join(existingDirectory, 'kanbrawl.json');
      writeFileSync(
        existingPath,
        JSON.stringify({
          columns: [
            { name: 'A', sortBy: 'created', sortOrder: 'asc' },
            { name: 'B', sortBy: 'updated', sortOrder: 'desc' },
          ],
          tasks: [
            {
              id: 'test-id',
              title: 'Existing',
              description: '',
              column: 'A',
              priority: 'P1',
              assignee: '',
              createdAt: '2025-01-01T00:00:00.000Z',
              updatedAt: '2025-01-01T00:00:00.000Z',
            },
          ],
        }),
      );

      const loaded = new BoardStore(existingPath, { watch: false });
      expect(loaded.getColumnNames()).toEqual(['A', 'B']);
      expect(loaded.getTasks()).toHaveLength(1);
      expect(loaded.getTasks()[0].title).toBe('Existing');
      loaded.dispose();
      rmSync(existingDirectory, { recursive: true, force: true });
    });

    it('fills in missing fields and files from a partial file', () => {
      const partialDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      const partialPath = join(partialDirectory, 'kanbrawl.json');
      writeFileSync(partialPath, JSON.stringify({}));

      const loaded = new BoardStore(partialPath, { watch: false });
      expect(loaded.getColumnNames()).toEqual(DEFAULT_COLUMN_NAMES);
      expect(loaded.getTasks()).toEqual([]);
      loaded.dispose();
      rmSync(partialDirectory, { recursive: true, force: true });
    });

    it('migrates old string[] columns to Column[] objects with IDs', () => {
      const migrateDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      const migratePath = join(migrateDirectory, 'kanbrawl.json');
      writeFileSync(
        migratePath,
        JSON.stringify({
          columns: ['Todo', 'In progress', 'Done'],
          tasks: [],
        }),
      );

      const loaded = new BoardStore(migratePath, { watch: false });
      const columns = loaded.getColumns();
      expect(columns.map((column) => column.name)).toEqual([
        'Todo',
        'In progress',
        'Done',
      ]);
      expect(columns.every((column) => Boolean(column.id))).toBe(true);
      expect(columns[0].sortBy).toBe('priority');
      expect(columns[2].sortOrder).toBe('desc');
      loaded.dispose();
      rmSync(migrateDirectory, { recursive: true, force: true });
    });

    it('sanitizes bad stored tasks instead of breaking reads', () => {
      const dirtyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      const dirtyPath = join(dirtyDirectory, 'kanbrawl.json');
      writeFileSync(
        dirtyPath,
        JSON.stringify({
          columns: [
            { name: 'Todo', sortBy: 'priority', sortOrder: 'asc' },
            { name: 'Done', sortBy: 'updated', sortOrder: 'desc' },
          ],
          tasks: [
            {
              id: 'bad',
              title: '  ',
              column: 'Missing',
              priority: 'P9',
            },
            { id: 'bad', title: 'Duplicate id', column: 'Done' },
          ],
        }),
      );

      const loaded = new BoardStore(dirtyPath, { watch: false });
      const tasks = loaded.getTasks();
      expect(tasks).toHaveLength(2);
      expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
      expect(tasks[0].title).toBe('Untitled task');
      expect(tasks[0].column).toBe('Todo');
      expect(tasks[0].priority).toBe('P1');
      loaded.dispose();
      rmSync(dirtyDirectory, { recursive: true, force: true });
    });

    it('throws a BoardError when the file is not valid JSON', () => {
      const badDirectory = mkdtempSync(join(tmpdir(), 'kanbrawl-store-test-'));
      const badPath = join(badDirectory, 'kanbrawl.json');
      writeFileSync(badPath, '{not json');
      expect(() => new BoardStore(badPath, { watch: false })).toThrow(
        BoardError,
      );
      rmSync(badDirectory, { recursive: true, force: true });
    });
  });

  // --- reads ---
  describe('reads', () => {
    it('returns deep clones of board data', () => {
      const board = store.getBoard();
      board.columns.push({
        id: 'extra',
        name: 'Extra',
        sortBy: 'created',
        sortOrder: 'asc',
      });
      expect(store.getColumns()).toHaveLength(4);

      store.createTask({ title: 'Original' });
      const tasks = store.getTasks();
      tasks[0].title = 'Mutated';
      expect(store.getTasks()[0].title).toBe('Original');
    });

    it('getTask returns a clone and undefined for unknown ids', () => {
      const created = store.createTask({ title: 'Find me' });
      const found = store.getTask(created.id)!;
      found.title = 'Mutated';
      expect(store.getTask(created.id)!.title).toBe('Find me');
      expect(store.getTask('nonexistent')).toBeUndefined();
    });

    it('filters tasks by column', () => {
      store.createTask({ title: 'A' });
      store.createTask({ title: 'B', column: 'Done' });
      expect(store.getTasks('Todo')).toHaveLength(1);
      expect(store.getTasks('Done')).toHaveLength(1);
      expect(store.getTasks('In progress')).toHaveLength(0);
    });
  });

  // --- createTask ---
  describe('createTask', () => {
    it('creates a task with defaults', () => {
      const task = store.createTask({ title: 'My task' });
      expect(task.title).toBe('My task');
      expect(task.column).toBe('Todo');
      expect(task.priority).toBe('P1');
      expect(task.description).toBe('');
      expect(task.assignee).toBe('');
      expect(task.lastActor).toBe('');
      expect(task.id).toBeDefined();
      expect(task.createdAt).toBe(task.updatedAt);
    });

    it('creates a task with all fields and an actor', () => {
      const task = store.createTask({
        title: 'Task',
        description: 'Description',
        column: 'In progress',
        priority: 'P0',
        assignee: 'agent',
        actor: 'planner',
      });
      expect(task.column).toBe('In progress');
      expect(task.priority).toBe('P0');
      expect(task.assignee).toBe('agent');
      expect(task.lastActor).toBe('planner');
    });

    it('trims title and assignee', () => {
      const task = store.createTask({
        title: '  Trimmed  ',
        assignee: '  bob ',
      });
      expect(task.title).toBe('Trimmed');
      expect(task.assignee).toBe('bob');
    });

    it('rejects invalid input with stable codes', () => {
      expect(() => store.createTask({ title: '   ' })).toThrow(/Title/);
      expect(() => store.createTask({ title: 'x'.repeat(201) })).toThrow(/200/);
      expect(() => store.createTask({ title: 'Task', priority: 'P9' })).toThrow(
        /Priority/,
      );
      expect(() =>
        store.createTask({ title: 'Task', description: 'x'.repeat(4001) }),
      ).toThrow(/4000/);
      expect(() =>
        store.createTask({ title: 'Task', assignee: 'x'.repeat(101) }),
      ).toThrow(/100/);
      expect(() =>
        store.createTask({ title: 'Task', column: 'Nonexistent' }),
      ).toThrow(/does not exist/);
    });

    it('persists to disk atomically without leaving temp files', () => {
      store.createTask({ title: 'Persisted' });
      const data = readBoard(filePath);
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].title).toBe('Persisted');
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual(
        [],
      );
      expect(readdirSync(dir)).not.toContain('kanbrawl.json.lock');
    });

    it('emits task_created once', () => {
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.createTask({ title: 'Evented' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_created');
    });

    it('is idempotent when clientRequestId is reused', () => {
      const first = store.createTask({
        title: 'Once',
        clientRequestId: 'key-1',
      });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const second = store.createTask({
        title: 'Once again',
        clientRequestId: 'key-1',
      });
      expect(second.id).toBe(first.id);
      expect(store.getTasks()).toHaveLength(1);
      expect(events).toHaveLength(0);
    });
  });

  // --- updateTask / moveTask ---
  describe('updateTask and moveTask', () => {
    it('updates fields and leaves others unchanged', () => {
      const task = store.createTask({
        title: 'Task',
        description: 'Original desc',
        assignee: 'alice',
      });
      const updated = store.updateTask(task.id, {
        title: 'New',
        priority: 'P0',
      });
      expect(updated.title).toBe('New');
      expect(updated.priority).toBe('P0');
      expect(updated.description).toBe('Original desc');
      expect(updated.assignee).toBe('alice');
    });

    it('updates fields and column in one operation with one event', () => {
      const task = store.createTask({ title: 'Task' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const updated = store.updateTask(task.id, {
        title: 'Moved and renamed',
        column: 'Done',
        actor: 'agent-7',
      });
      expect(updated.column).toBe('Done');
      expect(updated.lastActor).toBe('agent-7');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_moved');
      if (events[0].type === 'task_moved') {
        expect(events[0].fromColumn).toBe('Todo');
      }
    });

    it('does not partially apply an invalid column', () => {
      const task = store.createTask({ title: 'Task' });
      expect(() =>
        store.updateTask(task.id, { title: 'Changed', column: 'Nope' }),
      ).toThrow(/does not exist/);
      expect(store.getTask(task.id)!.title).toBe('Task');
    });

    it('emits task_updated for field-only changes', () => {
      const task = store.createTask({ title: 'Task' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.updateTask(task.id, { description: 'New desc' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_updated');
    });

    it('rejects stale writes with CONFLICT and returns the current task', async () => {
      const task = store.createTask({ title: 'Task' });
      await delay(2);
      store.updateTask(task.id, { title: 'First writer' });

      try {
        store.updateTask(task.id, {
          title: 'Second writer',
          expectedUpdatedAt: task.updatedAt,
        });
        expect.unreachable('expected a conflict');
      } catch (error) {
        expect(error).toBeInstanceOf(BoardError);
        const boardError = error as BoardError;
        expect(boardError.code).toBe('CONFLICT');
        expect((boardError.details?.current as { title: string }).title).toBe(
          'First writer',
        );
      }

      expect(store.getTask(task.id)!.title).toBe('First writer');
    });

    it('accepts a matching expectedUpdatedAt', () => {
      const task = store.createTask({ title: 'Task' });
      const updated = store.updateTask(task.id, {
        title: 'Safe',
        expectedUpdatedAt: task.updatedAt,
      });
      expect(updated.title).toBe('Safe');
    });

    it('throws for unknown tasks', () => {
      expect(() => store.moveTask('nonexistent', 'Done')).toThrow(/not found/);
      expect(() => {
        store.deleteTask('nonexistent');
      }).toThrow(/not found/);
    });
  });

  // --- deleteTask ---
  describe('deleteTask', () => {
    it('deletes and persists', () => {
      const task = store.createTask({ title: 'To delete' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.deleteTask(task.id);
      expect(store.getTasks()).toHaveLength(0);
      expect(readBoard(filePath).tasks).toHaveLength(0);
      expect(events[0].type).toBe('task_deleted');
    });
  });

  // --- updateColumns ---
  describe('updateColumns', () => {
    it('adds columns and keeps stable IDs', () => {
      const before = store.getColumns();
      const result = store.updateColumns([
        ...before,
        { name: 'Review', sortBy: 'created', sortOrder: 'asc' },
      ]);
      expect(result.map((column) => column.name)).toEqual([
        ...DEFAULT_COLUMN_NAMES,
        'Review',
      ]);
      expect(result.slice(0, 4).map((column) => column.id)).toEqual(
        before.map((column) => column.id),
      );
    });

    it('matches existing columns by name when IDs are omitted', () => {
      const before = store.getColumns();
      const result = store.updateColumns(
        DEFAULT_COLUMN_NAMES.map((name) => ({
          name,
          sortBy: 'created' as const,
          sortOrder: 'asc' as const,
        })),
      );
      expect(result.map((column) => column.id)).toEqual(
        before.map((column) => column.id),
      );
    });

    it('renames a column without moving its tasks', () => {
      const blocked = store
        .getColumns()
        .find((column) => column.name === 'Blocked')!;
      const task = store.createTask({ title: 'Stays', column: 'Blocked' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));

      const result = store.updateColumns(
        store
          .getColumns()
          .map((column) =>
            column.id === blocked.id ? { ...column, name: 'On hold' } : column,
          ),
      );

      expect(result.map((column) => column.name)).toContain('On hold');
      expect(store.getTask(task.id)!.column).toBe('On hold');
      expect(store.getTask(task.id)!.id).toBe(task.id);
      const moves = events.filter((event) => event.type === 'task_moved');
      expect(moves).toHaveLength(1);
    });

    it('moves tasks from a removed column to the requested destination', () => {
      const task = store.createTask({ title: 'Homeless', column: 'Blocked' });
      store.updateColumns(
        store.getColumns().filter((column) => column.name !== 'Blocked'),
        'Done',
      );
      expect(store.getTask(task.id)!.column).toBe('Done');
    });

    it('rejects invalid column lists', () => {
      expect(() => store.updateColumns([])).toThrow(/At least one/);
      expect(() =>
        store.updateColumns([
          { name: 'A', sortBy: 'created', sortOrder: 'asc' },
          { name: ' A ', sortBy: 'created', sortOrder: 'asc' },
        ]),
      ).toThrow(/unique/);
      expect(() =>
        store.updateColumns(
          [{ name: 'A', sortBy: 'created', sortOrder: 'asc' }],
          'Nonexistent',
        ),
      ).toThrow(/does not exist/);
    });

    it('emits columns_updated and persists', () => {
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.updateColumns([
        { name: 'Alpha', sortBy: 'priority', sortOrder: 'asc' },
        { name: 'Beta', sortBy: 'created', sortOrder: 'desc' },
      ]);
      expect(events.at(-1)?.type).toBe('columns_updated');
      expect(readBoard(filePath).columns.map((column) => column.name)).toEqual([
        'Alpha',
        'Beta',
      ]);
    });
  });

  // --- multi-process safety ---
  describe('shared file safety', () => {
    it('sees writes made by another store instance', () => {
      const other = new BoardStore(filePath, { watch: false });
      const created = other.createTask({ title: 'From another process' });
      expect(store.getTask(created.id)!.title).toBe('From another process');

      store.createTask({ title: 'From this process' });
      expect(other.getTasks()).toHaveLength(2);
      other.dispose();
    });

    it('recovers from a stale lock file', () => {
      const lockPath = `${filePath}.lock`;
      writeFileSync(lockPath, 'stale');
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);
      const task = store.createTask({ title: 'After stale lock' });
      expect(task.title).toBe('After stale lock');
    });

    it('broadcasts external changes to listeners', async () => {
      store.dispose();
      store = new BoardStore(filePath, { watch: true });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const other = new BoardStore(filePath, { watch: false });
      other.createTask({ title: 'External' });

      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && events.length === 0) {
        // eslint-disable-next-line no-await-in-loop
        await delay(25);
      }

      other.dispose();
      expect(events.some((event) => event.type === 'board_sync')).toBe(true);
    });
  });

  // --- onChange ---
  describe('onChange', () => {
    it('supports unsubscribe and multiple listeners', () => {
      const events1: BoardEvent[] = [];
      const events2: BoardEvent[] = [];
      const unsubscribe = store.onChange((event) => events1.push(event));
      store.onChange((event) => events2.push(event));

      store.createTask({ title: 'Task' });
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);

      unsubscribe();
      store.createTask({ title: 'Another' });
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(2);
    });
  });
});
