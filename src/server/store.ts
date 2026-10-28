import process from 'node:process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import {
  LIMITS,
  defaultColumns,
  type Board,
  type BoardEvent,
  type Column,
  type Priority,
  type SortBy,
  type SortOrder,
  type Task,
} from '../shared/board.js';
import { BoardError } from './errors.js';

const SORT_FIELDS = new Set<SortBy>(['priority', 'created', 'updated']);
const PRIORITIES = new Set<Priority>(['P0', 'P1', 'P2']);

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

function fileStamp(filePath: string): string {
  try {
    const stats = statSync(filePath);
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return '';
  }
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
    });
  }

  return { tasks, changed };
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

export class BoardStore {
  private data: Board;
  private readonly filePath: string;
  private readonly lockPath: string;
  private stamp = '';
  private listeners: Array<(event: BoardEvent) => void> = [];
  private watcher: FSWatcher | undefined;
  private syncTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(filePath?: string, options: BoardStoreOptions = {}) {
    this.filePath = filePath ?? resolve(process.cwd(), 'kanbrawl.json');
    this.lockPath = `${this.filePath}.lock`;
    const loaded = this.readFromDisk();
    this.data = loaded.data;
    this.stamp = loaded.stamp;
    if (loaded.changed) {
      this.writeAtomic(this.data);
    }

    if (options.watch !== false) {
      this.startWatching();
    }
  }

  private readFromDisk(): {
    data: Board;
    stamp: string;
    changed: boolean;
  } {
    if (!existsSync(this.filePath)) {
      return {
        data: { columns: defaultColumns(uuidv4), tasks: [] },
        stamp: '',
        changed: true,
      };
    }

    const raw = readFileSync(this.filePath, 'utf8');
    let parsed: Partial<Board> & { columns?: Array<Column | string> };
    try {
      parsed = JSON.parse(raw) as Partial<Board> & {
        columns?: Array<Column | string>;
      };
    } catch {
      throw new BoardError(
        'INVALID_BOARD_FILE',
        `Board file "${this.filePath}" is not valid JSON.`,
      );
    }

    const { columns, changed: columnsChanged } = normalizeStoredColumns(
      parsed.columns,
    );
    const { tasks, changed: tasksChanged } = normalizeStoredTasks(
      parsed.tasks,
      columns,
    );

    return {
      data: {
        columns,
        tasks,
        ...(parsed.theme ? { theme: parsed.theme } : {}),
      },
      stamp: fileStamp(this.filePath),
      changed: columnsChanged || tasksChanged,
    };
  }

  private writeAtomic(data: Board): void {
    const temporaryPath = `${this.filePath}.${process.pid}.${uuidv4()}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    renameSync(temporaryPath, this.filePath);
    this.stamp = fileStamp(this.filePath);
  }

  private syncFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    if (fileStamp(this.filePath) === this.stamp) return;
    const loaded = this.readFromDisk();
    this.data = loaded.data;
    this.stamp = loaded.stamp;
  }

  private startWatching(): void {
    try {
      this.watcher = watch(dirname(this.filePath), (_event, filename) => {
        if (filename && filename !== basename(this.filePath)) return;
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = setTimeout(() => {
          this.syncTimer = undefined;
          this.handleExternalChange();
        }, 50);
        this.syncTimer.unref();
      });
      this.watcher.unref();
      this.watcher.on('error', () => {
        this.stopWatching();
      });
    } catch {
      this.watcher = undefined;
    }
  }

  private stopWatching(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }

    this.watcher?.close();
    this.watcher = undefined;
  }

  private handleExternalChange(): void {
    try {
      if (!existsSync(this.filePath)) return;
      if (fileStamp(this.filePath) === this.stamp) return;
      const loaded = this.readFromDisk();
      this.data = loaded.data;
      this.stamp = loaded.stamp;
      this.emit({ type: 'board_sync', board: this.getBoard() });
    } catch {
      // A concurrent writer may be mid-replace; the next event will retry.
    }
  }

  private acquireLock(): () => void {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        closeSync(openSync(this.lockPath, 'wx'));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }

        this.removeStaleLock();
        if (Date.now() > deadline) {
          throw new BoardError(
            'BOARD_LOCKED',
            'The board file is locked by another process.',
          );
        }

        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }

    return () => {
      try {
        unlinkSync(this.lockPath);
      } catch {}
    };
  }

  private removeStaleLock(): void {
    try {
      if (Date.now() - statSync(this.lockPath).mtimeMs > 10_000) {
        unlinkSync(this.lockPath);
      }
    } catch {}
  }

  private mutate<T>(
    operation: (data: Board) => { result: T; events: BoardEvent[] },
  ): T {
    const release = this.acquireLock();
    try {
      this.syncFromDisk();
      const draft = clone(this.data);
      const { result, events } = operation(draft);
      this.data = draft;
      this.writeAtomic(draft);
      for (const event of events) {
        this.emit(event);
      }

      return result;
    } finally {
      release();
    }
  }

  private emit(event: BoardEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  onChange(listener: (event: BoardEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getBoard(): Board {
    this.syncFromDisk();
    return clone(this.data);
  }

  getColumns(): Column[] {
    this.syncFromDisk();
    return clone(this.data.columns);
  }

  getColumnNames(): string[] {
    return this.getColumns().map((column) => column.name);
  }

  getTasks(column?: string): Task[] {
    this.syncFromDisk();
    const tasks = column
      ? this.data.tasks.filter((task) => task.column === column)
      : this.data.tasks;
    return clone(tasks);
  }

  getTask(id: string): Task | undefined {
    this.syncFromDisk();
    const task = this.data.tasks.find((item) => item.id === id);
    return task ? clone(task) : undefined;
  }

  private findTask(data: Board, id: string): Task {
    const task = data.tasks.find((item) => item.id === id);
    if (!task) {
      throw new BoardError('TASK_NOT_FOUND', `Task with id "${id}" not found.`);
    }

    return task;
  }

  private requireColumn(data: Board, name: string): string {
    const target = typeof name === 'string' ? name.trim() : '';
    const names = data.columns.map((column) => column.name);
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

  createTask(fields: {
    title: string;
    description?: string;
    column?: string;
    priority?: string;
    assignee?: string;
    actor?: string;
    clientRequestId?: string;
  }): Task {
    return this.mutate((data) => {
      const title = normalizeTitle(fields.title);
      const description = normalizeDescription(fields.description ?? '');
      const assignee = normalizeAssignee(fields.assignee ?? '');
      const priority =
        fields.priority === undefined
          ? 'P1'
          : normalizePriority(fields.priority);
      const column =
        fields.column === undefined
          ? data.columns[0].name
          : this.requireColumn(data, fields.column);
      const clientRequestId =
        typeof fields.clientRequestId === 'string' &&
        fields.clientRequestId.trim().length > 0
          ? fields.clientRequestId.trim()
          : undefined;

      if (clientRequestId) {
        const existing = data.tasks.find(
          (task) => task.clientRequestId === clientRequestId,
        );
        if (existing) {
          return { result: clone(existing), events: [] };
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
      };

      data.tasks.push(task);
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
    return this.mutate((data) => {
      const task = this.findTask(data, id);
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
        task.column = this.requireColumn(data, fields.column);
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
      const event: BoardEvent =
        task.column === fromColumn
          ? { type: 'task_updated', task: clone(task) }
          : { type: 'task_moved', task: clone(task), fromColumn };

      return { result: clone(task), events: [event] };
    });
  }

  deleteTask(id: string): void {
    this.mutate((data) => {
      this.findTask(data, id);
      data.tasks = data.tasks.filter((task) => task.id !== id);
      return {
        result: undefined,
        events: [{ type: 'task_deleted', taskId: id }],
      };
    });
  }

  updateColumns(
    columns: Array<Partial<Column> & { name: string }>,
    moveTo?: string,
  ): Column[] {
    return this.mutate((data) => {
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

      const byId = new Map(data.columns.map((column) => [column.id, column]));
      const byName = new Map(
        data.columns.map((column) => [column.name, column]),
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
        data.columns.map((column) => [column.id, column.name]),
      );
      const renames = new Map<string, string>();
      for (const column of next) {
        const oldName = oldNameById.get(column.id);
        if (oldName !== undefined && oldName !== column.name) {
          renames.set(oldName, column.name);
        }
      }

      const removedNames = new Set(
        data.columns
          .filter((column) => !used.has(column.id))
          .map((column) => column.name),
      );
      const events: BoardEvent[] = [];

      for (const task of data.tasks) {
        const fromColumn = task.column;
        const target = removedNames.has(task.column)
          ? destination.name
          : renames.get(task.column);

        if (target !== undefined && target !== task.column) {
          task.column = target;
          task.updatedAt = now();
          events.push({
            type: 'task_moved',
            task: clone(task),
            fromColumn,
          });
        }
      }

      data.columns = next;
      events.push({ type: 'columns_updated', columns: clone(next) });
      return { result: clone(next), events };
    });
  }

  dispose(): void {
    this.stopWatching();
    this.listeners = [];
  }
}
