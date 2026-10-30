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
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  LIMITS,
  type BoardEvent,
  type Column,
  type Project,
  type Task,
} from '../shared/board.js';
import { migrate } from './migrations.js';
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

function expectBoardError(run: () => unknown): BoardError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BoardError);
    return error as BoardError;
  }

  throw new Error('Expected the call to throw a BoardError.');
}

describe('BoardStore', () => {
  let store: BoardStore;
  let databasePath: string;
  let dir: string;

  beforeEach(() => {
    ({ store, databasePath, dir } = createTestStore());
    testProject = undefined;
  });

  afterEach(() => {
    store.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  // Created through a separate connection so the seeding emits no events and
  // bumps no revision on the store under test.
  let testProject: Project | undefined;

  function ensureTestProject(): Project {
    if (!testProject) {
      const seeder = new BoardStore(databasePath, { watch: false });
      try {
        testProject = seeder.updateProjects([
          { name: 'Test project', folder: '' },
        ]).projects[0];
      } finally {
        seeder.dispose();
      }
    }

    return testProject;
  }

  // Most tests just need a valid task; the project contract is covered by the
  // "task projects" tests below. An explicit projectId is always honored.
  function newTask(fields: Parameters<BoardStore['createTask']>[0]): Task {
    return store.createTask({
      ...(fields.projectId === undefined
        ? { projectId: ensureTestProject().id }
        : {}),
      ...fields,
    });
  }

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
      newTask({ title: 'Persisted' });
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
      newTask({ title: 'Database wins' });
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

  // --- Schema migration ---
  describe('schema migration', () => {
    // The schema as it shipped before projects and versioned migrations
    // existed, kept as a literal so upgrades are tested against the real
    // old shape.
    const LEGACY_SCHEMA_V0 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS columns (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  sort_by TEXT NOT NULL,
  sort_order TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  column_name TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee TEXT NOT NULL,
  last_actor TEXT NOT NULL,
  client_request_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks(column_name);
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  filename TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments(task_id);
`;

    function createLegacyDatabase(databasePath: string): void {
      const database = new DatabaseSync(databasePath);
      try {
        database.exec(LEGACY_SCHEMA_V0);
        database
          .prepare(
            `INSERT INTO columns (position, id, name, sort_by, sort_order)
           VALUES (?, ?, ?, ?, ?)`,
          )
          .run(0, 'col-1', 'Todo', 'priority', 'asc');
        const insertTask = database.prepare(
          `INSERT INTO tasks (
             id, title, description, column_name, priority, assignee,
             last_actor, client_request_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        insertTask.run(
          'task-1',
          'Legacy one',
          'kept',
          'Todo',
          'P1',
          'ada',
          'ada',
          null,
          '2025-01-01T00:00:00.000Z',
          '2025-01-01T00:00:00.000Z',
        );
        insertTask.run(
          'task-2',
          'Legacy two',
          '',
          'Todo',
          'P2',
          '',
          'grace',
          null,
          '2025-01-02T00:00:00.000Z',
          '2025-01-02T00:00:00.000Z',
        );
        database
          .prepare(`INSERT INTO meta (key, value) VALUES ('theme', 'light')`)
          .run();
      } finally {
        database.close();
      }
    }

    // The snapshot compares the effective schema shape (columns per table,
    // index names, schema version), not the stored SQL text, which differs
    // between a freshly created and an upgraded database.
    function schemaSnapshot(databasePath: string) {
      const database = new DatabaseSync(databasePath);
      try {
        const userVersion = (
          database.prepare('PRAGMA user_version').get() as {
            user_version: number;
          }
        ).user_version;
        const tables = (
          [
            'attachments',
            'blobs',
            'columns',
            'meta',
            'projects',
            'tasks',
          ] as const
        ).map((name) => [
          name,
          database.prepare(`PRAGMA table_info(${name})`).all(),
        ]);
        const indexes = (
          database
            .prepare(
              `SELECT name FROM sqlite_master
               WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
               ORDER BY name`,
            )
            .all() as Array<{ name: string }>
        ).map((row) => row.name);
        return { userVersion, tables, indexes };
      } finally {
        database.close();
      }
    }

    function withTemporaryDatabase<T>(run: (databasePath: string) => T): T {
      const dir = mkdtempSync(join(tmpdir(), 'kanbrawl-migration-test-'));
      try {
        return run(join(dir, 'kanbrawl.db'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    function columnNames(
      snapshot: ReturnType<typeof schemaSnapshot>,
      table: string,
    ): string[] {
      const entry = snapshot.tables.find(([name]) => name === table);
      return entry
        ? (entry[1] as Array<{ name: string }>).map((column) => column.name)
        : [];
    }

    it('initializes a fresh database to the current schema version', () => {
      withTemporaryDatabase((databasePath) => {
        new BoardStore(databasePath, { watch: false }).dispose();
        const snapshot = schemaSnapshot(databasePath);
        expect(snapshot.userVersion).toBe(1);
        expect(columnNames(snapshot, 'projects')).toEqual([
          'id',
          'position',
          'name',
          'folder',
        ]);
        expect(columnNames(snapshot, 'tasks')).toContain('project_id');
        expect(snapshot.indexes).toContain('tasks_project_idx');
      });
    });

    it('upgrades a pre-projects database in place and keeps its data', () => {
      withTemporaryDatabase((databasePath) => {
        createLegacyDatabase(databasePath);
        const upgraded = new BoardStore(databasePath, { watch: false });
        try {
          expect(upgraded.getColumnNames()).toEqual(['Todo']);
          const tasks = upgraded.getTasks();
          expect(tasks.map((task) => task.title)).toEqual([
            'Legacy one',
            'Legacy two',
          ]);
          expect(tasks[0].description).toBe('kept');
          expect(upgraded.getBoard().theme).toBe('light');
        } finally {
          upgraded.dispose();
        }

        const snapshot = schemaSnapshot(databasePath);
        expect(snapshot.userVersion).toBe(1);
        expect(columnNames(snapshot, 'projects')).toEqual([
          'id',
          'position',
          'name',
          'folder',
        ]);
        expect(columnNames(snapshot, 'tasks')).toContain('project_id');
        expect(snapshot.indexes).toContain('tasks_project_idx');
      });
    });

    it('is safe to re-run on an already migrated database', () => {
      withTemporaryDatabase((databasePath) => {
        createLegacyDatabase(databasePath);
        new BoardStore(databasePath, { watch: false }).dispose();
        const before = schemaSnapshot(databasePath);
        const database = new DatabaseSync(databasePath);
        try {
          migrate(database);
          migrate(database);
        } finally {
          database.close();
        }

        expect(schemaSnapshot(databasePath)).toEqual(before);
      });
    });

    it('ends in the same schema state whether fresh or upgraded', () => {
      withTemporaryDatabase((legacyPath) => {
        createLegacyDatabase(legacyPath);
        new BoardStore(legacyPath, { watch: false }).dispose();
        withTemporaryDatabase((freshPath) => {
          new BoardStore(freshPath, { watch: false }).dispose();
          expect(schemaSnapshot(freshPath)).toEqual(schemaSnapshot(legacyPath));
        });
      });
    });

    it('backs project deletion with a database-level foreign key', () => {
      withTemporaryDatabase((databasePath) => {
        createLegacyDatabase(databasePath);
        new BoardStore(databasePath, { watch: false }).dispose();
        const database = new DatabaseSync(databasePath);
        try {
          database.exec('PRAGMA foreign_keys = ON');
          database
            .prepare(
              'INSERT INTO projects (position, id, name, folder) VALUES (?, ?, ?, ?)',
            )
            .run(0, 'proj-1', 'Kanbrawl', '/code/kanbrawl');
          database
            .prepare('UPDATE tasks SET project_id = ? WHERE id = ?')
            .run('proj-1', 'task-1');
          expect(() =>
            database.prepare('DELETE FROM projects WHERE id = ?').run('proj-1'),
          ).toThrow();
          database
            .prepare('UPDATE tasks SET project_id = NULL WHERE id = ?')
            .run('task-1');
          expect(() =>
            database.prepare('DELETE FROM projects WHERE id = ?').run('proj-1'),
          ).not.toThrow();
        } finally {
          database.close();
        }
      });
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

      newTask({ title: 'Original' });
      const tasks = store.getTasks();
      tasks[0].title = 'Mutated';
      expect(store.getTasks()[0].title).toBe('Original');
    });

    it('getTask returns a clone and undefined for unknown ids', () => {
      const created = newTask({ title: 'Find me' });
      const found = store.getTask(created.id)!;
      found.title = 'Mutated';
      expect(store.getTask(created.id)!.title).toBe('Find me');
      expect(store.getTask('nonexistent')).toBeUndefined();
    });

    it('filters tasks by column', () => {
      newTask({ title: 'A' });
      newTask({ title: 'B', column: 'Done' });
      expect(store.getTasks('Todo')).toHaveLength(1);
      expect(store.getTasks('Done')).toHaveLength(1);
      expect(store.getTasks('In progress')).toHaveLength(0);
    });
  });

  // --- task projects ---
  describe('task projects', () => {
    function seedProject(name = 'Kanbrawl'): Project {
      const seeder = new BoardStore(databasePath, { watch: false });
      try {
        return seeder.updateProjects([{ name, folder: '' }]).projects[0];
      } finally {
        seeder.dispose();
      }
    }

    it('requires a project when creating a task', () => {
      seedProject();
      const missing = expectBoardError(() =>
        store.createTask({ title: 'Orphan' }),
      );
      expect(missing.code).toBe('INVALID_PROJECT');

      const nulled = expectBoardError(() =>
        store.createTask({
          title: 'Orphan',
          projectId: null as unknown as string,
        }),
      );
      expect(nulled.code).toBe('INVALID_PROJECT');

      const blank = expectBoardError(() =>
        store.createTask({ title: 'Orphan', projectId: '   ' }),
      );
      expect(blank.code).toBe('INVALID_PROJECT');
      expect(store.getTasks()).toEqual([]);
    });

    it('rejects an unknown project with PROJECT_NOT_FOUND', () => {
      seedProject();
      const error = expectBoardError(() =>
        store.createTask({
          title: 'Orphan',
          projectId: '00000000-0000-0000-0000-000000000000',
        }),
      );
      expect(error.code).toBe('PROJECT_NOT_FOUND');
      expect(store.getTasks()).toEqual([]);
    });

    it('stores the project and carries it in task events', () => {
      const project = seedProject();
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const task = store.createTask({ title: 'Owned', projectId: project.id });
      expect(task.projectId).toBe(project.id);
      expect(store.getTask(task.id)!.projectId).toBe(project.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_created',
        task: { id: task.id, projectId: project.id },
      });
    });

    it('keeps the current project when an update omits it', () => {
      const project = seedProject();
      const task = store.createTask({
        title: 'Owned',
        projectId: project.id,
      });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const updated = store.updateTask(task.id, { title: 'Renamed' });
      expect(updated.projectId).toBe(project.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'task_updated',
        task: { id: task.id, projectId: project.id },
      });
    });

    it('rejects an explicit null or unknown project on update', () => {
      const project = seedProject();
      const task = store.createTask({
        title: 'Owned',
        projectId: project.id,
      });

      const nulled = expectBoardError(() =>
        store.updateTask(task.id, {
          projectId: null as unknown as string,
        }),
      );
      expect(nulled.code).toBe('INVALID_PROJECT');

      const unknown = expectBoardError(() =>
        store.updateTask(task.id, {
          projectId: '00000000-0000-0000-0000-000000000000',
        }),
      );
      expect(unknown.code).toBe('PROJECT_NOT_FOUND');
      expect(store.getTask(task.id)!.projectId).toBe(project.id);
    });

    function unclassify(taskId: string): void {
      const database = new DatabaseSync(databasePath);
      try {
        database
          .prepare('UPDATE tasks SET project_id = NULL WHERE id = ?')
          .run(taskId);
      } finally {
        database.close();
      }
    }

    it('requires choosing a project when editing a task without one', () => {
      const project = seedProject();
      const task = store.createTask({
        title: 'Legacy',
        projectId: project.id,
      });
      unclassify(task.id);

      const error = expectBoardError(() =>
        store.updateTask(task.id, { title: 'Renamed' }),
      );
      expect(error.code).toBe('INVALID_PROJECT');
      expect(store.getTask(task.id)!.title).toBe('Legacy');

      const classified = store.updateTask(task.id, {
        title: 'Renamed',
        projectId: project.id,
      });
      expect(classified.projectId).toBe(project.id);
      expect(classified.title).toBe('Renamed');
    });

    it('never touches the project when moving between columns', () => {
      const project = seedProject();
      const task = store.createTask({
        title: 'Movable',
        projectId: project.id,
      });
      const moved = store.moveTask(task.id, 'Done');
      expect(moved.column).toBe('Done');
      expect(moved.projectId).toBe(project.id);

      // A move is project-neutral, also for a task that has no project yet.
      const legacy = store.createTask({
        title: 'Legacy',
        projectId: project.id,
      });
      unclassify(legacy.id);
      const movedLegacy = store.moveTask(legacy.id, 'Blocked');
      expect(movedLegacy.column).toBe('Blocked');
      expect(movedLegacy.projectId).toBeUndefined();
    });

    it('keeps legacy JSON imports in the unclassified pool', () => {
      const legacyDirectory = mkdtempSync(
        join(tmpdir(), 'kanbrawl-store-test-'),
      );
      writeLegacyJson(legacyDirectory, {
        tasks: [
          {
            id: 'legacy-1',
            title: 'Imported',
            description: '',
            column: 'Todo',
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
      try {
        const task = imported.getTasks()[0];
        expect(task.projectId).toBeUndefined();

        // Editing an imported task must choose a project...
        expectBoardError(() =>
          imported.updateTask(task.id, { assignee: 'someone' }),
        );

        // ...and once it does, the task leaves the unclassified pool.
        const project = imported.updateProjects([
          { name: 'Imported work', folder: '' },
        ]).projects[0];
        const classified = imported.updateTask(task.id, {
          projectId: project.id,
        });
        expect(classified.projectId).toBe(project.id);
      } finally {
        imported.dispose();
        rmSync(legacyDirectory, { recursive: true, force: true });
      }
    });

    it('resumes a classification backfill after a conflict and finishes at zero', () => {
      const project = seedProject();
      const tasks = ['One', 'Two', 'Three'].map((title) => {
        const task = store.createTask({ title, projectId: project.id });
        unclassify(task.id);
        return task;
      });

      const unclassified = () =>
        store.getTasks().filter((task) => task.projectId === undefined);
      expect(unclassified().map((task) => task.title)).toEqual([
        'One',
        'Two',
        'Three',
      ]);

      // First backfill pass classifies one task, then the run is interrupted.
      store.updateTask(tasks[0].id, { projectId: project.id });
      expect(unclassified()).toHaveLength(2);

      // On resume, task Two was moved by somebody else in the meantime (a move
      // is project-neutral and allowed on unclassified tasks): the stale write
      // fails with CONFLICT, and the documented recovery re-reads the task and
      // decides again instead of replaying the stale decision.
      const stale = store.getTask(tasks[1].id)!;
      store.moveTask(tasks[1].id, 'Blocked');
      const conflict = expectBoardError(() =>
        store.updateTask(tasks[1].id, {
          projectId: project.id,
          expectedUpdatedAt: stale.updatedAt,
        }),
      );
      expect(conflict.code).toBe('CONFLICT');
      expect(unclassified()).toHaveLength(2);

      const reread = store.getTask(tasks[1].id)!;
      store.updateTask(tasks[1].id, {
        projectId: project.id,
        expectedUpdatedAt: reread.updatedAt,
      });
      store.updateTask(tasks[2].id, { projectId: project.id });

      // Migration complete: zero tasks without a project.
      expect(unclassified()).toEqual([]);
    });

    it('still requires a project on create while unclassified tasks exist', () => {
      const project = seedProject();
      const legacy = store.createTask({
        title: 'Legacy',
        projectId: project.id,
      });
      unclassify(legacy.id);

      const error = expectBoardError(() => store.createTask({ title: 'New' }));
      expect(error.code).toBe('INVALID_PROJECT');
    });
  });

  // --- createTask ---
  describe('createTask', () => {
    it('creates a task with defaults', () => {
      const task = newTask({ title: 'My task' });
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
      const task = newTask({
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
      const task = newTask({
        title: '  Trimmed  ',
        assignee: '  bob ',
      });
      expect(task.title).toBe('Trimmed');
      expect(task.assignee).toBe('bob');
    });

    it('rejects invalid input with stable codes', () => {
      expect(() => newTask({ title: '   ' })).toThrow(/Title/);
      expect(() => newTask({ title: 'x'.repeat(201) })).toThrow(/200/);
      expect(() => newTask({ title: 'Task', priority: 'P9' })).toThrow(
        /Priority/,
      );
      expect(() =>
        newTask({ title: 'Task', description: 'x'.repeat(4001) }),
      ).toThrow(/4000/);
      expect(() =>
        newTask({ title: 'Task', assignee: 'x'.repeat(101) }),
      ).toThrow(/100/);
      expect(() => newTask({ title: 'Task', column: 'Nonexistent' })).toThrow(
        /does not exist/,
      );
    });

    it('persists to disk and leaves no lock or temporary files', () => {
      newTask({ title: 'Persisted' });
      expect(readBoard(databasePath).tasks[0].title).toBe('Persisted');
      expect(
        readdirSync(dir).filter((name) => /\.(tmp|lock)$/.test(name)),
      ).toEqual([]);
    });

    it('emits task_created once', () => {
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      newTask({ title: 'Evented' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_created');
    });

    it('is idempotent when clientRequestId is reused', () => {
      const first = newTask({
        title: 'Once',
        clientRequestId: 'key-1',
      });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const second = newTask({
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
      const task = newTask({
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
      const task = newTask({ title: 'Task' });
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
      const task = newTask({ title: 'Task' });
      expect(() =>
        store.updateTask(task.id, { title: 'Changed', column: 'Nope' }),
      ).toThrow(/does not exist/);
      expect(store.getTask(task.id)!.title).toBe('Task');
    });

    it('emits task_updated for field-only changes', () => {
      const task = newTask({ title: 'Task' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.updateTask(task.id, { description: 'New desc' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_updated');
    });

    it('rejects stale writes with CONFLICT and returns the current task', async () => {
      const task = newTask({ title: 'Task' });
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
      const task = newTask({ title: 'Task' });
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
      const task = newTask({ title: 'To delete' });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      store.deleteTask(task.id);
      expect(store.getTasks()).toHaveLength(0);
      expect(readBoard(databasePath).tasks).toHaveLength(0);
      expect(events[0].type).toBe('task_deleted');
    });

    it('deletes the task attachments with it', () => {
      const task = newTask({ title: 'With image' });
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
      const task = newTask({ title: 'Stays', column: 'Blocked' });
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
      const task = newTask({ title: 'Homeless', column: 'Blocked' });
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

  // --- updateProjects ---
  describe('updateProjects', () => {
    function createCatalog() {
      const first = store.updateProjects([
        { name: 'Kanbrawl', folder: '/code/kanbrawl' },
        { name: 'Ops', folder: '/code/ops' },
      ]);
      return {
        first: first.projects[0],
        second: first.projects[1],
        revision: first.revision,
      };
    }

    it('creates projects with server-assigned ids and exposes them', () => {
      const { projects, revision } = store.updateProjects([
        { name: 'Kanbrawl', folder: '/code/kanbrawl' },
        { name: 'Ops', folder: '/code/ops' },
      ]);

      expect(projects.map((project) => project.name)).toEqual([
        'Kanbrawl',
        'Ops',
      ]);
      expect(projects.map((project) => project.folder)).toEqual([
        '/code/kanbrawl',
        '/code/ops',
      ]);
      expect(projects.every((project) => Boolean(project.id))).toBe(true);
      expect(new Set(projects.map((project) => project.id)).size).toBe(2);
      expect(revision).toBe(1);

      expect(store.getProjects()).toEqual(projects);
      const board = store.getBoard();
      expect(board.projects).toEqual(projects);
      expect(board.projectsRevision).toBe(1);
    });

    it('renames, reorders and edits folders by id', () => {
      const { first, second } = createCatalog();
      const { projects, revision } = store.updateProjects([
        { id: second.id, name: 'Runbook', folder: '/code/runbook' },
        { id: first.id, name: 'Kanbrawl', folder: '/code/kanbrawl' },
      ]);

      expect(projects.map((project) => project.name)).toEqual([
        'Runbook',
        'Kanbrawl',
      ]);
      expect(projects.map((project) => project.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(projects[0].folder).toBe('/code/runbook');
      expect(revision).toBe(2);
    });

    it('keeps ids when matching by name and mints ids for new entries', () => {
      const { first } = createCatalog();
      const { projects } = store.updateProjects([
        { name: 'Kanbrawl', folder: '/code/kanbrawl' },
        { name: 'Fresh', folder: '/code/fresh' },
      ]);

      expect(projects.map((project) => project.name)).toEqual([
        'Kanbrawl',
        'Fresh',
      ]);
      expect(projects[0].id).toBe(first.id);
      expect(projects[1].id).not.toBe(first.id);
    });

    it('deletes projects missing from the list and allows an empty catalog', () => {
      const { first, revision } = createCatalog();
      const dropped = store.updateProjects([
        { id: first.id, name: 'Kanbrawl', folder: '/code/kanbrawl' },
      ]);
      expect(dropped.projects.map((project) => project.name)).toEqual([
        'Kanbrawl',
      ]);
      expect(dropped.revision).toBe(revision + 1);

      const cleared = store.updateProjects([]);
      expect(cleared.projects).toEqual([]);
      expect(cleared.revision).toBe(revision + 2);
      expect(store.getProjects()).toEqual([]);
    });

    it('stores the folder exactly as given', () => {
      const folder = String.raw`  C:\Repos\personal\My Project\src/../ `;
      const { projects } = store.updateProjects([{ name: 'Windowsy', folder }]);
      expect(projects[0].folder).toBe(folder);
      expect(readBoard(databasePath).projects[0].folder).toBe(folder);
    });

    it('rejects duplicate names with DUPLICATE_PROJECT', () => {
      createCatalog();
      const error = expectBoardError(() =>
        store.updateProjects([
          { name: 'Kanbrawl', folder: '/a' },
          { name: 'Kanbrawl ', folder: '/b' },
        ]),
      );
      expect(error.code).toBe('DUPLICATE_PROJECT');
      expect(store.getProjects().map((project) => project.name)).toEqual([
        'Kanbrawl',
        'Ops',
      ]);
      expect(store.getBoard().projectsRevision).toBe(1);
    });

    it('rejects malformed items with INVALID_PROJECTS', () => {
      const callUpdate = (projects: unknown) =>
        store.updateProjects(projects as Array<Partial<Project>>);
      const invalid: unknown[] = [
        [{ name: '   ', folder: '/a' }],
        [{ folder: '/a' }],
        [{ name: 'No folder' }],
        [{ name: 'Bad folder', folder: 42 }],
      ];
      const errors = invalid.map((projects) =>
        expectBoardError(() => callUpdate(projects)),
      );
      for (const error of errors) {
        expect(error.code).toBe('INVALID_PROJECTS');
      }

      expect(store.getProjects()).toEqual([]);
      expect(store.getBoard().projectsRevision).toBe(0);
    });

    it('rolls back the whole change when one item is rejected', () => {
      const { first, second } = createCatalog();
      const error = expectBoardError(() =>
        store.updateProjects([
          { id: first.id, name: 'Renamed', folder: '/new' },
          { id: second.id, name: 'Renamed', folder: '/new' },
        ]),
      );
      expect(error.code).toBe('DUPLICATE_PROJECT');

      expect(store.getProjects().map((project) => project.name)).toEqual([
        'Kanbrawl',
        'Ops',
      ]);
      expect(store.getBoard().projectsRevision).toBe(1);
    });

    it('increments the revision on every accepted change', () => {
      const first = store.updateProjects([{ name: 'Only', folder: '' }]);
      expect(first.revision).toBe(1);
      const second = store.updateProjects([{ name: 'Only', folder: '' }]);
      expect(second.revision).toBe(2);
    });

    it('rejects a stale expectedRevision with CONFLICT', () => {
      const { first, revision } = createCatalog();
      const error = expectBoardError(() =>
        store.updateProjects(
          [{ id: first.id, name: 'Kanbrawl', folder: '/code/kanbrawl' }],
          revision - 1,
        ),
      );
      expect(error.code).toBe('CONFLICT');
      expect(error.details?.currentRevision).toBe(revision);
      expect(Array.isArray(error.details?.projects)).toBe(true);

      expect(store.getBoard().projectsRevision).toBe(revision);
    });

    it('accepts a matching expectedRevision and last-write-wins without one', () => {
      const { first, revision } = createCatalog();
      const guarded = store.updateProjects(
        [{ id: first.id, name: 'Guarded', folder: '' }],
        revision,
      );
      expect(guarded.revision).toBe(revision + 1);

      const unguarded = store.updateProjects([
        { name: 'Unguarded', folder: '' },
      ]);
      expect(unguarded.projects.map((project) => project.name)).toEqual([
        'Unguarded',
      ]);
      expect(unguarded.revision).toBe(revision + 2);
    });

    it('rejects a non-numeric expectedRevision with INVALID_PROJECTS', () => {
      createCatalog();
      const error = expectBoardError(() =>
        store.updateProjects([], 'stale' as unknown as number),
      );
      expect(error.code).toBe('INVALID_PROJECTS');
    });

    it('emits projects_updated with the new list and revision', () => {
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const { projects, revision } = store.updateProjects([
        { name: 'Emitted', folder: '/emitted' },
      ]);

      expect(events).toEqual([
        { type: 'projects_updated', projects, revision },
      ]);
    });

    it('persists the catalog and its revision across reopen', () => {
      const { projects, revision } = store.updateProjects([
        { name: 'Persisted', folder: '/persisted' },
      ]);
      const reopened = readBoard(databasePath);
      expect(reopened.projects).toEqual(projects);
      expect(reopened.projectsRevision).toBe(revision);
    });

    it('refuses to delete a project that still holds tasks', () => {
      const { projects, revision } = store.updateProjects([
        { name: 'Holds tasks', folder: '' },
      ]);
      const project = projects[0];
      newTask({ title: 'Referencing task', projectId: project.id });

      const error = expectBoardError(() =>
        store.updateProjects([{ name: 'New project', folder: '' }]),
      );
      expect(error.code).toBe('PROJECT_NOT_EMPTY');
      expect(error.details).toEqual({
        projectId: project.id,
        taskCount: 1,
      });

      // The rejected delete rolls back the addition too.
      expect(store.getProjects().map((item) => item.name)).toEqual([
        'Holds tasks',
      ]);
      expect(store.getBoard().projectsRevision).toBe(revision);
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
      const task = newTask({ title: 'With image' });
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
      const task = newTask({ title: 'Sniffed' });
      const meta = store.addAttachment(task.id, {
        data: pngBytes(2),
        filename: 'photo.jpg',
      });
      expect(meta.mimeType).toBe('image/png');
      expect(meta.filename).toBe('photo.jpg');
    });

    it('sanitizes the filename and falls back to a default', () => {
      const task = newTask({ title: 'Names' });
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
      const task = newTask({ title: 'Same image' });
      const first = addPng(task.id, 5);
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const second = addPng(task.id, 5);
      expect(second.id).toBe(first.id);
      expect(store.getTask(task.id)!.attachments).toHaveLength(1);
      expect(events).toHaveLength(0);
    });

    it('rejects non-images, empty data and oversized images', () => {
      const task = newTask({ title: 'Rejected' });
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
      const task = newTask({ title: 'Limit' });
      for (let index = 0; index < LIMITS.attachmentsPerTask; index += 1) {
        addPng(task.id, 10 + index);
      }

      expect(() => addPng(task.id, 100)).toThrow(/at most 10/);
    });

    it('emits attachments_changed without touching updatedAt', () => {
      const task = newTask({ title: 'Evented image' });
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
      const task = newTask({ title: 'Delete image' });
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
      const task = newTask({ title: 'Missing target' });
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
      const created = other.createTask({
        title: 'From another process',
        projectId: ensureTestProject().id,
      });
      expect(store.getTask(created.id)!.title).toBe('From another process');

      newTask({ title: 'From this process' });
      expect(other.getTasks()).toHaveLength(2);
      other.dispose();
    });

    it('broadcasts external changes to listeners', async () => {
      store.dispose();
      store = new BoardStore(databasePath, { watch: true });
      const events: BoardEvent[] = [];
      store.onChange((event) => events.push(event));
      const other = new BoardStore(databasePath, { watch: false });
      other.createTask({
        title: 'External',
        projectId: ensureTestProject().id,
      });

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

      newTask({ title: 'Task' });
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);

      unsubscribe();
      newTask({ title: 'Another' });
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(2);
    });
  });
});
