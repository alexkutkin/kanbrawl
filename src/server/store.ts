import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { v4 as uuidv4 } from 'uuid';
import {
  LIMITS,
  defaultColumns,
  type AttachmentMeta,
  type Board,
  type BoardEvent,
  type Column,
  type Priority,
  type SortBy,
  type SortOrder,
  type Task,
} from '../shared/board.js';
import { BoardError } from './errors.js';
import { detectImageType, sanitizeFilename, type ImageType } from './images.js';

const SORT_FIELDS = new Set<SortBy>(['priority', 'created', 'updated']);
const PRIORITIES = new Set<Priority>(['P0', 'P1', 'P2']);

const SCHEMA = `
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

type ColumnRow = {
  position: number;
  id: string;
  name: string;
  sort_by: SortBy;
  sort_order: SortOrder;
};

type TaskRow = {
  id: string;
  title: string;
  description: string;
  column_name: string;
  priority: Priority;
  assignee: string;
  last_actor: string;
  client_request_id: string | undefined;
  created_at: string;
  updated_at: string;
};

type AttachmentRow = {
  id: string;
  task_id: string;
  sha256: string;
  filename: string;
  position: number;
  created_at: string;
  mime_type: string;
  size: number;
};

type AttachmentRowWithData = AttachmentRow & { data: Uint8Array };

function isPriority(value: unknown): value is Priority {
  return PRIORITIES.has(value as Priority);
}

function isSortBy(value: unknown): value is SortBy {
  return SORT_FIELDS.has(value as SortBy);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now(): string {
  return new Date().toISOString();
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BoardError('INVALID_TITLE', 'Title is required.');
  }

  const title = value.trim();
  if (title.length === 0) {
    throw new BoardError('INVALID_TITLE', 'Title is required.');
  }

  if (title.length > LIMITS.title) {
    throw new BoardError(
      'INVALID_TITLE',
      `Title must not exceed ${LIMITS.title} characters.`,
    );
  }

  return title;
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BoardError(
      'INVALID_DESCRIPTION',
      'Description must be a string.',
    );
  }

  if (value.length > LIMITS.description) {
    throw new BoardError(
      'INVALID_DESCRIPTION',
      `Description must not exceed ${LIMITS.description} characters.`,
    );
  }

  return value;
}

function normalizeAssignee(value: unknown): string {
  if (typeof value !== 'string') {
    throw new BoardError('INVALID_ASSIGNEE', 'Assignee must be a string.');
  }

  const assignee = value.trim();
  if (assignee.length > LIMITS.assignee) {
    throw new BoardError(
      'INVALID_ASSIGNEE',
      `Assignee must not exceed ${LIMITS.assignee} characters.`,
    );
  }

  return assignee;
}

function normalizePriority(value: unknown): Priority {
  if (!isPriority(value)) {
    throw new BoardError(
      'INVALID_PRIORITY',
      'Priority must be one of P0, P1 or P2.',
    );
  }

  return value;
}

function migrateLegacyColumn(name: string): Column {
  const lower = name.toLowerCase();
  const sortBy: SortBy = lower === 'todo' ? 'priority' : 'created';
  const sortOrder: SortOrder = lower === 'done' ? 'desc' : 'asc';
  return { id: uuidv4(), name, sortBy, sortOrder };
}

function normalizeStoredColumns(raw: Array<Column | string> | undefined): {
  columns: Column[];
  changed: boolean;
} {
  const source = raw && raw.length > 0 ? raw : defaultColumns(uuidv4);
  let changed = !raw || raw.length === 0;
  const names = new Set<string>();
  const ids = new Set<string>();
  const columns: Column[] = [];

  for (const item of source) {
    const candidate =
      typeof item === 'string' ? migrateLegacyColumn(item) : { ...item };
    const name =
      typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name || names.has(name)) {
      changed = true;
      continue;
    }

    names.add(name);
    let id =
      typeof candidate.id === 'string' && candidate.id.length > 0
        ? candidate.id
        : uuidv4();
    if (ids.has(id)) {
      id = uuidv4();
      changed = true;
    }

    const sortBy = isSortBy(candidate.sortBy) ? candidate.sortBy : 'created';
    const sortOrder: SortOrder =
      candidate.sortOrder === 'desc' ? 'desc' : 'asc';
    const column: Column = { id, name, sortBy, sortOrder };
    if (
      id !== candidate.id ||
      name !== candidate.name ||
      sortBy !== candidate.sortBy ||
      sortOrder !== candidate.sortOrder
    ) {
      changed = true;
    }

    ids.add(id);
    columns.push(column);
  }

  if (columns.length === 0) {
    return { columns: defaultColumns(uuidv4), changed: true };
  }

  return { columns, changed };
}

function normalizeStoredTasks(
  raw: unknown,
  columns: Column[],
): { tasks: Task[]; changed: boolean } {
  if (!Array.isArray(raw)) {
    return { tasks: [], changed: true };
  }

  const names = new Set(columns.map((column) => column.name));
  const fallback = columns[0].name;
  const ids = new Set<string>();
  const tasks: Task[] = [];
  let changed = false;

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      changed = true;
      continue;
    }

    const candidate = item as Partial<Task>;
    let id =
      typeof candidate.id === 'string' && candidate.id.length > 0
        ? candidate.id
        : uuidv4();
    if (ids.has(id)) {
      id = uuidv4();
      changed = true;
    }

    ids.add(id);

    let title =
      typeof candidate.title === 'string' ? candidate.title.trim() : '';
    if (!title) {
      title = 'Untitled task';
      changed = true;
    } else if (title.length > LIMITS.title) {
      title = title.slice(0, LIMITS.title);
      changed = true;
    }

    const description =
      typeof candidate.description === 'string' ? candidate.description : '';
    const priority = isPriority(candidate.priority) ? candidate.priority : 'P1';
    const assignee =
      typeof candidate.assignee === 'string' ? candidate.assignee.trim() : '';
    const column =
      typeof candidate.column === 'string' && names.has(candidate.column)
        ? candidate.column
        : fallback;
    const createdAt =
      typeof candidate.createdAt === 'string' && candidate.createdAt
        ? candidate.createdAt
        : now();
    const updatedAt =
      typeof candidate.updatedAt === 'string' && candidate.updatedAt
        ? candidate.updatedAt
        : createdAt;
    const lastActor =
      typeof candidate.lastActor === 'string' ? candidate.lastActor : '';
    const clientRequestId =
      typeof candidate.clientRequestId === 'string'
        ? candidate.clientRequestId
        : undefined;

    if (
      description !== candidate.description ||
      priority !== candidate.priority ||
      assignee !== candidate.assignee ||
      column !== candidate.column ||
      createdAt !== candidate.createdAt ||
      updatedAt !== candidate.updatedAt ||
      lastActor !== candidate.lastActor ||
      clientRequestId !== candidate.clientRequestId
    ) {
      changed = true;
    }

    tasks.push({
      id,
      title,
      description: description.slice(0, LIMITS.description),
      column,
      priority,
      assignee: assignee.slice(0, LIMITS.assignee),
      lastActor,
      ...(clientRequestId ? { clientRequestId } : {}),
      createdAt,
      updatedAt,
      attachments: [],
    });
  }

  return { tasks, changed };
}

function toColumn(row: ColumnRow): Column {
  return {
    id: row.id,
    name: row.name,
    sortBy: row.sort_by,
    sortOrder: row.sort_order,
  };
}

function toAttachment(row: AttachmentRow): AttachmentMeta {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

function toTask(row: TaskRow, attachments: AttachmentMeta[]): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    column: row.column_name,
    priority: row.priority,
    assignee: row.assignee,
    lastActor: row.last_actor,
    ...(row.client_request_id
      ? { clientRequestId: row.client_request_id }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachments,
  };
}

type TaskFields = {
  title?: string;
  description?: string;
  priority?: string;
  assignee?: string;
  column?: string;
};

type TaskMutationOptions = {
  actor?: string;
  expectedUpdatedAt?: string;
};

export type BoardStoreOptions = {
  watch?: boolean;
};

export type AttachmentInput = {
  data: Uint8Array;
  filename?: string;
};

export type AttachmentContent = {
  meta: AttachmentMeta;
  data: Uint8Array;
};

function legacyJsonPath(databasePath: string): string {
  const replaced = databasePath.replace(/\.[^./\\]+$/, '.json');
  return replaced === databasePath ? `${databasePath}.json` : replaced;
}

export function ensureBoardFile(databasePath: string): 'created' | 'exists' {
  if (existsSync(databasePath)) {
    return 'exists';
  }

  const store = new BoardStore(databasePath, { watch: false });
  store.dispose();
  return 'created';
}

export class BoardStore {
  private readonly database: DatabaseSync;
  private readonly legacyPath: string;
  private readonly watchTimer: ReturnType<typeof setInterval> | undefined;
  private dataVersion = 0;
  private transactionDepth = 0;
  private listeners: Array<(event: BoardEvent) => void> = [];
  private disposed = false;

  private readonly selectColumns: StatementSync;
  private readonly selectTasks: StatementSync;
  private readonly selectTasksByColumn: StatementSync;
  private readonly selectTask: StatementSync;
  private readonly selectTaskByRequest: StatementSync;
  private readonly selectAttachments: StatementSync;
  private readonly selectAttachmentsByTask: StatementSync;
  private readonly selectAttachment: StatementSync;
  private readonly selectAttachmentWithBlob: StatementSync;
  private readonly selectAttachmentByHash: StatementSync;
  private readonly countAttachments: StatementSync;
  private readonly countColumns: StatementSync;
  private readonly insertColumn: StatementSync;
  private readonly deleteColumns: StatementSync;
  private readonly insertTask: StatementSync;
  private readonly updateTaskRow: StatementSync;
  private readonly updateTaskColumn: StatementSync;
  private readonly deleteTaskRow: StatementSync;
  private readonly insertBlob: StatementSync;
  private readonly insertAttachment: StatementSync;
  private readonly deleteAttachmentRow: StatementSync;
  private readonly deleteOrphanBlobs: StatementSync;
  private readonly selectMeta: StatementSync;
  private readonly upsertMeta: StatementSync;

  constructor(databasePath?: string, options: BoardStoreOptions = {}) {
    const filePath = databasePath ?? resolve(process.cwd(), 'kanbrawl.db');
    this.legacyPath = legacyJsonPath(filePath);
    this.database = new DatabaseSync(filePath);

    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA auto_vacuum = INCREMENTAL;
    `);
    this.database.exec(SCHEMA);

    this.selectColumns = this.database.prepare(
      'SELECT * FROM columns ORDER BY position',
    );
    this.selectTasks = this.database.prepare(
      'SELECT * FROM tasks ORDER BY created_at, rowid',
    );
    this.selectTasksByColumn = this.database.prepare(
      'SELECT * FROM tasks WHERE column_name = ? ORDER BY created_at, rowid',
    );
    this.selectTask = this.database.prepare('SELECT * FROM tasks WHERE id = ?');
    this.selectTaskByRequest = this.database.prepare(
      'SELECT * FROM tasks WHERE client_request_id = ?',
    );
    this.selectAttachments = this.database.prepare(
      `SELECT a.*, b.mime_type, b.size FROM attachments a
       JOIN blobs b ON b.sha256 = a.sha256
       ORDER BY a.position`,
    );
    this.selectAttachmentsByTask = this.database.prepare(
      `SELECT a.*, b.mime_type, b.size FROM attachments a
       JOIN blobs b ON b.sha256 = a.sha256
       WHERE a.task_id = ?
       ORDER BY a.position`,
    );
    this.selectAttachment = this.database.prepare(
      'SELECT * FROM attachments WHERE id = ?',
    );
    this.selectAttachmentWithBlob = this.database.prepare(
      `SELECT a.*, b.mime_type, b.size, b.data FROM attachments a
       JOIN blobs b ON b.sha256 = a.sha256
       WHERE a.id = ?`,
    );
    this.selectAttachmentByHash = this.database.prepare(
      `SELECT a.*, b.mime_type, b.size FROM attachments a
       JOIN blobs b ON b.sha256 = a.sha256
       WHERE a.task_id = ? AND a.sha256 = ?`,
    );
    this.countAttachments = this.database.prepare(
      'SELECT COUNT(*) AS count FROM attachments WHERE task_id = ?',
    );
    this.countColumns = this.database.prepare(
      'SELECT COUNT(*) AS count FROM columns',
    );
    this.insertColumn = this.database.prepare(
      `INSERT INTO columns (position, id, name, sort_by, sort_order)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.deleteColumns = this.database.prepare('DELETE FROM columns');
    this.insertTask = this.database.prepare(
      `INSERT INTO tasks (
        id, title, description, column_name, priority, assignee,
        last_actor, client_request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.updateTaskRow = this.database.prepare(
      `UPDATE tasks SET
        title = ?, description = ?, column_name = ?, priority = ?,
        assignee = ?, last_actor = ?, updated_at = ?
       WHERE id = ?`,
    );
    this.updateTaskColumn = this.database.prepare(
      'UPDATE tasks SET column_name = ?, updated_at = ? WHERE id = ?',
    );
    this.deleteTaskRow = this.database.prepare(
      'DELETE FROM tasks WHERE id = ?',
    );
    this.insertBlob = this.database.prepare(
      `INSERT OR IGNORE INTO blobs (sha256, mime_type, size, data, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.insertAttachment = this.database.prepare(
      `INSERT INTO attachments (id, task_id, sha256, filename, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.deleteAttachmentRow = this.database.prepare(
      'DELETE FROM attachments WHERE id = ?',
    );
    this.deleteOrphanBlobs = this.database.prepare(
      'DELETE FROM blobs WHERE sha256 NOT IN (SELECT sha256 FROM attachments)',
    );
    this.selectMeta = this.database.prepare(
      'SELECT value FROM meta WHERE key = ?',
    );
    this.upsertMeta = this.database.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );

    try {
      this.importLegacyJson();
      if (Number(this.countColumns.get()?.count ?? 0) === 0) {
        this.writeColumns(defaultColumns(uuidv4));
      }
    } catch (error) {
      this.database.close();
      throw error;
    }

    if (options.watch !== false) {
      this.watchTimer = this.startWatching();
    }
  }

  private importLegacyJson(): void {
    if (Number(this.countColumns.get()?.count ?? 0) > 0) return;
    if (!existsSync(this.legacyPath)) return;

    let parsed: Partial<Board> & { columns?: Array<Column | string> };
    try {
      parsed = JSON.parse(
        readFileSync(this.legacyPath, 'utf8'),
      ) as Partial<Board> & { columns?: Array<Column | string> };
    } catch {
      throw new BoardError(
        'INVALID_BOARD_FILE',
        `Board file "${this.legacyPath}" is not valid JSON.`,
      );
    }

    const { columns } = normalizeStoredColumns(parsed.columns);
    const { tasks } = normalizeStoredTasks(parsed.tasks, columns);

    this.transaction(() => {
      this.writeColumns(columns);
      for (const task of tasks) {
        this.insertTask.run(
          task.id,
          task.title,
          task.description,
          task.column,
          task.priority,
          task.assignee,
          task.lastActor,
          task.clientRequestId ?? null,
          task.createdAt,
          task.updatedAt,
        );
      }

      if (parsed.theme === 'light' || parsed.theme === 'dark') {
        this.upsertMeta.run('theme', parsed.theme);
      }
    });

    try {
      const importedPath = `${this.legacyPath}.imported`;
      rmSync(importedPath, { force: true });
      renameSync(this.legacyPath, importedPath);
    } catch {}
  }

  private startWatching(): ReturnType<typeof setInterval> {
    this.dataVersion = this.readDataVersion();
    const timer = setInterval(() => {
      try {
        const version = this.readDataVersion();
        if (version === this.dataVersion) return;
        this.dataVersion = version;
        this.emit({ type: 'board_sync', board: this.readBoard() });
      } catch {
        // The database may be busy with another commit; the next tick retries.
      }
    }, 1000);
    timer.unref();
    return timer;
  }

  private readDataVersion(): number {
    const row = this.database.prepare('PRAGMA data_version').get() as
      | { data_version: number }
      | undefined;
    return row?.data_version ?? 0;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = operation();
      this.transactionDepth--;
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.transactionDepth--;
      try {
        this.database.exec('ROLLBACK');
      } catch {}

      throw error;
    }
  }

  private readTransaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.database.exec('BEGIN');
    this.transactionDepth++;
    try {
      const result = operation();
      this.transactionDepth--;
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.transactionDepth--;
      try {
        this.database.exec('ROLLBACK');
      } catch {}

      throw error;
    }
  }

  private mutate<T>(operation: () => { result: T; events: BoardEvent[] }): T {
    const { result, events } = this.transaction(operation);
    for (const event of events) {
      this.emit(event);
    }

    return result;
  }

  private compact(): void {
    try {
      this.database.exec('PRAGMA incremental_vacuum');
    } catch {}
  }

  private emit(event: BoardEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  onChange(listener: (event: BoardEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  private readColumns(): Column[] {
    return (this.selectColumns.all() as unknown as ColumnRow[]).map((row) =>
      toColumn(row),
    );
  }

  private readAttachments(taskId?: string): AttachmentMeta[] {
    const rows = (taskId === undefined
      ? this.selectAttachments.all()
      : this.selectAttachmentsByTask.all(taskId)) as unknown as AttachmentRow[];
    return rows.map((row) => toAttachment(row));
  }

  private readTasks(column?: string): Task[] {
    const rows = (column === undefined
      ? this.selectTasks.all()
      : this.selectTasksByColumn.all(column)) as unknown as TaskRow[];
    if (rows.length === 0) return [];

    const attachments = new Map<string, AttachmentMeta[]>();
    for (const meta of this.readAttachments()) {
      const list = attachments.get(meta.taskId) ?? [];
      list.push(meta);
      attachments.set(meta.taskId, list);
    }

    return rows.map((row) => toTask(row, attachments.get(row.id) ?? []));
  }

  private readTask(id: string): Task | undefined {
    const row = this.selectTask.get(id) as unknown as TaskRow | undefined;
    if (!row) return undefined;
    return toTask(row, this.readAttachments(id));
  }

  private readBoard(): Board {
    return this.readTransaction(() => {
      const themeRow = this.selectMeta.get('theme') as
        | { value: string }
        | undefined;
      const theme =
        themeRow?.value === 'light' || themeRow?.value === 'dark'
          ? themeRow.value
          : undefined;
      return {
        columns: this.readColumns(),
        tasks: this.readTasks(),
        ...(theme ? { theme } : {}),
      };
    });
  }

  private findTask(id: string): Task {
    const task = this.readTask(id);
    if (!task) {
      throw new BoardError('TASK_NOT_FOUND', `Task with id "${id}" not found.`);
    }

    return task;
  }

  private requireColumn(name: string): string {
    const target = typeof name === 'string' ? name.trim() : '';
    const names = this.readColumns().map((column) => column.name);
    if (!names.includes(target)) {
      throw new BoardError(
        'COLUMN_NOT_FOUND',
        `Column "${target}" does not exist. Available columns: ${names.join(', ')}`,
        { availableColumns: names },
      );
    }

    return target;
  }

  private applyActor(task: Task, actor: string | undefined): void {
    if (actor === undefined) return;
    task.lastActor = actor.trim().slice(0, LIMITS.assignee);
  }

  private assertExpected(
    task: Task,
    expectedUpdatedAt: string | undefined,
  ): void {
    if (
      expectedUpdatedAt !== undefined &&
      expectedUpdatedAt !== task.updatedAt
    ) {
      throw new BoardError(
        'CONFLICT',
        'The task was changed by someone else. Reload it and try again.',
        { current: clone(task) },
      );
    }
  }

  private writeTask(task: Task): void {
    this.updateTaskRow.run(
      task.title,
      task.description,
      task.column,
      task.priority,
      task.assignee,
      task.lastActor,
      task.updatedAt,
      task.id,
    );
  }

  private writeColumns(columns: Column[]): void {
    this.deleteColumns.run();
    for (const [position, column] of columns.entries()) {
      this.insertColumn.run(
        position,
        column.id,
        column.name,
        column.sortBy,
        column.sortOrder,
      );
    }
  }

  getBoard(): Board {
    return clone(this.readBoard());
  }

  getColumns(): Column[] {
    return clone(this.readTransaction(() => this.readColumns()));
  }

  getColumnNames(): string[] {
    return this.getColumns().map((column) => column.name);
  }

  getTasks(column?: string): Task[] {
    return clone(this.readTransaction(() => this.readTasks(column)));
  }

  getTask(id: string): Task | undefined {
    const task = this.readTransaction(() => this.readTask(id));
    return task ? clone(task) : undefined;
  }

  createTask(fields: {
    title: string;
    description?: string;
    column?: string;
    priority?: string;
    assignee?: string;
    actor?: string;
    clientRequestId?: string;
  }): Task {
    return this.mutate(() => {
      const title = normalizeTitle(fields.title);
      const description = normalizeDescription(fields.description ?? '');
      const assignee = normalizeAssignee(fields.assignee ?? '');
      const priority =
        fields.priority === undefined
          ? 'P1'
          : normalizePriority(fields.priority);
      const column =
        fields.column === undefined
          ? this.readColumns()[0].name
          : this.requireColumn(fields.column);
      const clientRequestId =
        typeof fields.clientRequestId === 'string' &&
        fields.clientRequestId.trim().length > 0
          ? fields.clientRequestId.trim()
          : undefined;

      if (clientRequestId) {
        const existing = this.selectTaskByRequest.get(clientRequestId) as
          | TaskRow
          | undefined;
        if (existing) {
          return {
            result: clone(toTask(existing, this.readAttachments(existing.id))),
            events: [],
          };
        }
      }

      const timestamp = now();
      const task: Task = {
        id: uuidv4(),
        title,
        description,
        column,
        priority,
        assignee,
        lastActor: (fields.actor ?? assignee).trim().slice(0, LIMITS.assignee),
        ...(clientRequestId ? { clientRequestId } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        attachments: [],
      };

      this.insertTask.run(
        task.id,
        task.title,
        task.description,
        task.column,
        task.priority,
        task.assignee,
        task.lastActor,
        task.clientRequestId ?? null,
        task.createdAt,
        task.updatedAt,
      );

      return {
        result: clone(task),
        events: [{ type: 'task_created', task: clone(task) }],
      };
    });
  }

  moveTask(
    id: string,
    column: string,
    options: TaskMutationOptions = {},
  ): Task {
    return this.updateTask(id, {
      column,
      actor: options.actor,
      expectedUpdatedAt: options.expectedUpdatedAt,
    });
  }

  updateTask(id: string, fields: TaskFields & TaskMutationOptions): Task {
    return this.mutate(() => {
      const task = this.findTask(id);
      this.assertExpected(task, fields.expectedUpdatedAt);
      const fromColumn = task.column;
      let changed = false;

      if (fields.title !== undefined) {
        task.title = normalizeTitle(fields.title);
        changed = true;
      }

      if (fields.description !== undefined) {
        task.description = normalizeDescription(fields.description);
        changed = true;
      }

      if (fields.priority !== undefined) {
        task.priority = normalizePriority(fields.priority);
        changed = true;
      }

      if (fields.assignee !== undefined) {
        task.assignee = normalizeAssignee(fields.assignee);
        changed = true;
      }

      if (fields.column !== undefined) {
        task.column = this.requireColumn(fields.column);
        changed = true;
      }

      if (fields.actor !== undefined) {
        this.applyActor(task, fields.actor);
        changed = true;
      }

      if (!changed) {
        return { result: clone(task), events: [] };
      }

      task.updatedAt = now();
      this.writeTask(task);
      const event: BoardEvent =
        task.column === fromColumn
          ? { type: 'task_updated', task: clone(task) }
          : { type: 'task_moved', task: clone(task), fromColumn };

      return { result: clone(task), events: [event] };
    });
  }

  deleteTask(id: string): void {
    this.mutate(() => {
      this.findTask(id);
      this.deleteTaskRow.run(id);
      this.deleteOrphanBlobs.run();
      return {
        result: undefined,
        events: [{ type: 'task_deleted', taskId: id }],
      };
    });
    this.compact();
  }

  updateColumns(
    columns: Array<Partial<Column> & { name: string }>,
    moveTo?: string,
  ): Column[] {
    return this.mutate(() => {
      if (!Array.isArray(columns) || columns.length === 0) {
        throw new BoardError(
          'INVALID_COLUMNS',
          'At least one column is required.',
        );
      }

      const requested = columns.map((item) => ({
        ...item,
        name: typeof item.name === 'string' ? item.name.trim() : '',
      }));

      if (requested.some((item) => item.name.length === 0)) {
        throw new BoardError(
          'INVALID_COLUMNS',
          'Column names must not be empty.',
        );
      }

      const names = requested.map((item) => item.name);
      if (new Set(names).size !== names.length) {
        throw new BoardError(
          'DUPLICATE_COLUMN',
          'Column names must be unique.',
        );
      }

      const currentColumns = this.readColumns();
      const byId = new Map(currentColumns.map((column) => [column.id, column]));
      const byName = new Map(
        currentColumns.map((column) => [column.name, column]),
      );
      const used = new Set<string>();
      const next: Column[] = [];

      for (const item of requested) {
        let existing = item.id ? byId.get(item.id) : undefined;
        if (existing && used.has(existing.id)) {
          existing = undefined;
        }

        if (!existing) {
          const candidate = byName.get(item.name);
          if (candidate && !used.has(candidate.id)) {
            existing = candidate;
          }
        }

        const id = existing ? existing.id : uuidv4();
        used.add(id);
        next.push({
          id,
          name: item.name,
          sortBy: isSortBy(item.sortBy) ? item.sortBy : 'created',
          sortOrder: item.sortOrder === 'desc' ? 'desc' : 'asc',
        });
      }

      const destination = moveTo
        ? next.find(
            (column) => column.id === moveTo || column.name === moveTo.trim(),
          )
        : next[0];
      if (!destination) {
        throw new BoardError(
          'COLUMN_NOT_FOUND',
          `Column "${moveTo}" does not exist in the new column list.`,
          { availableColumns: next.map((column) => column.name) },
        );
      }

      const oldNameById = new Map(
        currentColumns.map((column) => [column.id, column.name]),
      );
      const renames = new Map<string, string>();
      for (const column of next) {
        const oldName = oldNameById.get(column.id);
        if (oldName !== undefined && oldName !== column.name) {
          renames.set(oldName, column.name);
        }
      }

      const removedNames = new Set(
        currentColumns
          .filter((column) => !used.has(column.id))
          .map((column) => column.name),
      );
      const events: BoardEvent[] = [];

      for (const task of this.readTasks()) {
        const fromColumn = task.column;
        const target = removedNames.has(task.column)
          ? destination.name
          : renames.get(task.column);

        if (target !== undefined && target !== task.column) {
          const updatedAt = now();
          this.updateTaskColumn.run(target, updatedAt, task.id);
          task.column = target;
          task.updatedAt = updatedAt;
          events.push({
            type: 'task_moved',
            task: clone(task),
            fromColumn,
          });
        }
      }

      this.writeColumns(next);
      events.push({ type: 'columns_updated', columns: clone(next) });
      return { result: clone(next), events };
    });
  }

  addAttachment(taskId: string, input: AttachmentInput): AttachmentMeta {
    return this.mutate(() => {
      this.findTask(taskId);
      const size = input.data.length;
      if (size === 0) {
        throw new BoardError('INVALID_ATTACHMENT', 'The attachment is empty.');
      }

      if (size > LIMITS.attachmentSize) {
        throw new BoardError(
          'ATTACHMENT_TOO_LARGE',
          `Images must not exceed ${Math.floor(
            LIMITS.attachmentSize / 1024 / 1024,
          )} MB.`,
        );
      }

      const type: ImageType | undefined = detectImageType(input.data);
      if (!type) {
        throw new BoardError(
          'INVALID_ATTACHMENT',
          'Only PNG, JPEG, GIF and WebP images are supported.',
        );
      }

      const sha256 = createHash('sha256').update(input.data).digest('hex');
      const existing = this.selectAttachmentByHash.get(taskId, sha256) as
        | AttachmentRow
        | undefined;
      if (existing) {
        return { result: clone(toAttachment(existing)), events: [] };
      }

      const count = Number(this.countAttachments.get(taskId)?.count ?? 0);
      if (count >= LIMITS.attachmentsPerTask) {
        throw new BoardError(
          'ATTACHMENT_LIMIT',
          `A task can have at most ${LIMITS.attachmentsPerTask} images.`,
        );
      }

      const id = uuidv4();
      const createdAt = now();
      const filename = sanitizeFilename(input.filename, type.extension);
      this.insertBlob.run(sha256, type.mimeType, size, input.data, createdAt);
      this.insertAttachment.run(id, taskId, sha256, filename, count, createdAt);

      const attachments = this.readAttachments(taskId);
      const meta = attachments.find((item) => item.id === id)!;
      return {
        result: clone(meta),
        events: [
          {
            type: 'attachments_changed',
            taskId,
            attachments: clone(attachments),
          },
        ],
      };
    });
  }

  getAttachment(id: string): AttachmentContent | undefined {
    return this.readTransaction(() => {
      const row = this.selectAttachmentWithBlob.get(id) as
        | AttachmentRowWithData
        | undefined;
      if (!row) return undefined;
      return { meta: toAttachment(row), data: Uint8Array.from(row.data) };
    });
  }

  deleteAttachment(id: string): void {
    this.mutate(() => {
      const row = this.selectAttachment.get(id) as AttachmentRow | undefined;
      if (!row) {
        throw new BoardError(
          'ATTACHMENT_NOT_FOUND',
          `Attachment with id "${id}" not found.`,
        );
      }

      this.deleteAttachmentRow.run(id);
      this.deleteOrphanBlobs.run();
      const attachments = this.readAttachments(row.task_id);
      return {
        result: undefined,
        events: [
          {
            type: 'attachments_changed',
            taskId: row.task_id,
            attachments,
          },
        ],
      };
    });
    this.compact();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.listeners = [];
    this.database.close();
  }
}
