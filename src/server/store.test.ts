import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LIMITS, type BoardEvent, type Column } from '../shared/board.js';
import { BoardStore } from './store.js';
import { BoardError } from './errors.js';

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

function createTestStore(watch = false) {
  const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-store-test-'));
  const databasePath = join(dir, 'kanbrawl.db');
  const store = new BoardStore(databasePath, { watch });
  return { store, databasePath, dir };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readBoard(databasePath: string) {
  const store = new BoardStore(databasePath, { watch: false });
  try {
    return store.getBoard();
  } finally {
    store.dispose();
  }
}

function writeLegacyJson(dir: string, data: unknown): string {
  const filePath = join(dir, 'kanbrawl.json');
  writeFileSync(
    filePath,
    typeof data === 'string' ? data : JSON.stringify(data),
  );
  return filePath;
}

describe('BoardStore', () => {
  let store: BoardStore;
  let databasePath: string;
  let dir: string;

  beforeEach(() => {
    ({ store, databasePath, dir } = createTestStore());
  });

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Initialization ---
  describe('initialization', () => {
    it('creates the database with default columns when it does not exist', () => {
      expect(existsSync(databasePath)).toBe(true);
      const data = readBoard(databasePath);
      expect(data.columns.map((column) => column.name)).toEqual(
        DEFAULT_COLUMN_NAMES,
      );
      expect(data.columns.every((column) => Boolean(column.id))).toBe(true);
      expect(new Set(data.columns.map((column) => column.id)).size).toBe(4);
      expect(data.tasks).toEqual([]);
    });

    it('loads existing data from the database', () => {
      store.createTask({ title: 'Persisted' });
      const loaded = new BoardStore(databasePath, { watch: false });
      expect(loaded.getColumnNames()).toEqual(DEFAULT_COLUMN_NAMES);
      expect(loaded.getTasks()).toHaveLength(1);
      expect(loaded.getTasks()[0].title).toBe('Persisted');
      loaded.dispose();
    });

    it('imports a legacy JSON board once and renames it', () => {
      const legacyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      const jsonPath = writeLegacyJson(legacyDirectory, {
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
      });

      const imported = new BoardStore(join(legacyDirectory, 'kanbrawl.db'), {
        watch: false,
      });
      expect(imported.getColumnNames()).toEqual(['A', 'B']);
      expect(imported.getTasks()).toHaveLength(1);
      expect(imported.getTasks()[0].title).toBe('Existing');
      imported.dispose();

      expect(existsSync(jsonPath)).toBe(false);
      expect(existsSync(`${jsonPath}.imported`)).toBe(true);
      rmSync(legacyDirectory, { recursive: true, force: true });
    });

    it('fills in missing fields when importing a partial JSON board', () => {
      const legacyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      writeLegacyJson(legacyDirectory, {});

      const imported = new BoardStore(join(legacyDirectory, 'kanbrawl.db'), {
        watch: false,
      });
      expect(imported.getColumnNames()).toEqual(DEFAULT_COLUMN_NAMES);
      expect(imported.getTasks()).toEqual([]);
      imported.dispose();
      rmSync(legacyDirectory, { recursive: true, force: true });
    });

    it('migrates old string[] columns to Column[] objects with IDs', () => {
      const legacyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      writeLegacyJson(legacyDirectory, {
        columns: ['Todo', 'In progress', 'Done'],
        tasks: [],
      });

      const imported = new BoardStore(join(legacyDirectory, 'kanbrawl.db'), {
        watch: false,
      });
      const columns = imported.getColumns();
      expect(columns.map((column) => column.name)).toEqual([
        'Todo',
        'In progress',
        'Done',
      ]);
      expect(columns.every((column) => Boolean(column.id))).toBe(true);
      expect(columns[0].sortBy).toBe('priority');
      expect(columns[2].sortOrder).toBe('desc');
      imported.dispose();
      rmSync(legacyDirectory, { recursive: true, force: true });
    });

    it('sanitizes bad stored tasks instead of breaking reads', () => {
      const legacyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      writeLegacyJson(legacyDirectory, {
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
      });

      const imported = new BoardStore(join(legacyDirectory, 'kanbrawl.db'), {
        watch: false,
      });
      const tasks = imported.getTasks();
      expect(tasks).toHaveLength(2);
      expect(new Set(tasks.map((task) => task.id)).size).toBe(2);
      expect(tasks[0].title).toBe('Untitled task');
      expect(tasks[0].column).toBe('Todo');
      expect(tasks[0].priority).toBe('P1');
      imported.dispose();
      rmSync(legacyDirectory, { recursive: true, force: true });
    });

    it('does not import JSON into a database that already has data', () => {
      store.createTask({ title: 'Database wins' });
      store.dispose();
      writeLegacyJson(dir, {
        columns: [{ name: 'Legacy', sortBy: 'created', sortOrder: 'asc' }],
        tasks: [],
      });

      store = new BoardStore(databasePath, { watch: false });
      expect(store.getColumnNames()).toEqual(DEFAULT_COLUMN_NAMES);
      expect(store.getTasks()).toHaveLength(1);
      expect(existsSync(join(dir, 'kanbrawl.json'))).toBe(true);
    });

    it('throws a BoardError when the legacy file is not valid JSON', () => {
      const legacyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      writeLegacyJson(legacyDirectory, '{not json');
      expect(
        () =>
          new BoardStore(join(legacyDirectory, 'kanbrawl.db'), {
            watch: false,
          }),
      ).toThrow(BoardError);
      expect(existsSync(join(legacyDirectory, 'kanbrawl.json'))).toBe(true);
      rmSync(legacyDirectory, { recursive: true, force: true });
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
      expect(task.attachments).toEqual([]);
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

    it('persists to disk and leaves no lock or temporary files', () => {
      store.createTask({ title: 'Persisted' });
      expect(readBoard(databasePath).tasks[0].title).toBe('Persisted');
      expect(
        readdirSync(dir).filter((name) => /\.(tmp|lock)$/.test(name)),
      ).toEqual([]);
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
      expect(readBoard(databasePath).tasks).toHaveLength(0);
      expect(events[0].type).toBe('task_deleted');
    });

    it('deletes the task attachments with it', () => {
      const task = store.createTask({ title: 'With image' });
      const meta = store.addAttachment(task.id, {
        data: pngBytes(1),
        filename: 'shot.png',
      });
      store.deleteTask(task.id);
      expect(store.getAttachment(meta.id)).toBeUndefined();
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
      expect(
        readBoard(databasePath).columns.map((column) => column.name),
      ).toEqual(['Alpha', 'Beta']);
    });
  });

  // --- attachments ---
  describe('attachments', () => {
    function addPng(taskId: string, seed = 1) {
      return store.addAttachment(taskId, {
        data: pngBytes(seed),
        filename: 'screenshot.png',
      });
    }

    it('stores an image and exposes it on the task and the board', () => {
      const task = store.createTask({ title: 'With image' });
      const meta = addPng(task.id);
      expect(meta.mimeType).toBe('image/png');
      expect(meta.size).toBe(pngBytes(1).length);
      expect(meta.sha256).toBe(
        createHash('sha256').update(pngBytes(1)).digest('hex'),
      );
      expect(
        store.getTask(task.id)!.attachments.map((item) => item.id),
      ).toEqual([meta.id]);
      expect(store.getBoard().tasks[0].attachments).toHaveLength(1);
      const content = store.getAttachment(meta.id)!;
      expect(Uint8Array.from(content.data)).toEqual(pngBytes(1));
    });

    it('sniffs the type and ignores the filename extension', () => {
      const task = store.createTask({ title: 'Sniffed' });
      const meta = store.addAttachment(task.id, {
        data: pngBytes(2),
        filename: 'photo.jpg',
      });
      expect(meta.mimeType).toBe('image/png');
      expect(meta.filename).toBe('photo.jpg');
    });

    it('sanitizes the filename and falls back to a default', () => {
      const task = store.createTask({ title: 'Names' });
      expect(
        store.addAttachment(task.id, {
          data: pngBytes(3),
          filename: '../../shot.png',
        }).filename,
      ).toBe('shot.png');

      const unnamed = store.addAttachment(task.id, { data: pngBytes(4) });
      expect(unnamed.filename).toBe('image.png');
    });

    it('deduplicates identical images on one task', () => {
      const task = store.createTask({ title: 'Same image' });
      const first = addPng(task.id, 5);
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const second = addPng(task.id, 5);
      expect(second.id).toBe(first.id);
      expect(store.getTask(task.id)!.attachments).toHaveLength(1);
      expect(events).toHaveLength(0);
    });

    it('rejects non-images, empty data and oversized images', () => {
      const task = store.createTask({ title: 'Rejected' });
      expect(() =>
        store.addAttachment(task.id, {
          data: new TextEncoder().encode('not an image'),
          filename: 'notes.txt',
        }),
      ).toThrow(/PNG, JPEG, GIF and WebP/);
      expect(() =>
        store.addAttachment(task.id, { data: new Uint8Array(0) }),
      ).toThrow(/empty/);
      expect(() =>
        store.addAttachment(task.id, {
          data: new Uint8Array(LIMITS.attachmentSize + 1).fill(1),
        }),
      ).toThrow(/10 MB/);
      expect(store.getTask(task.id)!.attachments).toHaveLength(0);
    });

    it('limits the number of images per task', () => {
      const task = store.createTask({ title: 'Limit' });
      for (let index = 0; index < LIMITS.attachmentsPerTask; index += 1) {
        addPng(task.id, 10 + index);
      }

      expect(() => addPng(task.id, 100)).toThrow(/at most 10/);
    });

    it('emits attachments_changed without touching updatedAt', () => {
      const task = store.createTask({ title: 'Evented image' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const meta = addPng(task.id);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('attachments_changed');
      if (events[0].type === 'attachments_changed') {
        expect(events[0].taskId).toBe(task.id);
        expect(events[0].attachments.map((item) => item.id)).toEqual([meta.id]);
      }

      expect(store.getTask(task.id)!.updatedAt).toBe(task.updatedAt);
    });

    it('deletes an image and reports the remaining list', () => {
      const task = store.createTask({ title: 'Delete image' });
      const first = addPng(task.id, 20);
      const second = addPng(task.id, 21);
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.deleteAttachment(first.id);
      expect(store.getAttachment(first.id)).toBeUndefined();
      expect(events[0].type).toBe('attachments_changed');
      if (events[0].type === 'attachments_changed') {
        expect(events[0].attachments.map((item) => item.id)).toEqual([
          second.id,
        ]);
      }
    });

    it('throws for unknown attachments and tasks', () => {
      expect(() => {
        store.deleteAttachment('nonexistent');
      }).toThrow(/not found/);
      const task = store.createTask({ title: 'Missing target' });
      expect(() =>
        store.addAttachment('nonexistent', { data: pngBytes(30) }),
      ).toThrow(/not found/);
      expect(store.getTask(task.id)!.attachments).toHaveLength(0);
    });
  });

  // --- multi-process safety ---
  describe('shared database safety', () => {
    it('sees writes made by another store instance', () => {
      const other = new BoardStore(databasePath, { watch: false });
      const created = other.createTask({ title: 'From another process' });
      expect(store.getTask(created.id)!.title).toBe('From another process');

      store.createTask({ title: 'From this process' });
      expect(other.getTasks()).toHaveLength(2);
      other.dispose();
    });

    it('broadcasts external changes to listeners', async () => {
      store.dispose();
      store = new BoardStore(databasePath, { watch: true });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const other = new BoardStore(databasePath, { watch: false });
      other.createTask({ title: 'External' });

      const deadline = Date.now() + 4000;
      while (Date.now() < deadline && events.length === 0) {
        // eslint-disable-next-line no-await-in-loop
        await delay(50);
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
