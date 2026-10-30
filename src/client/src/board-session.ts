import {
  applyBoardEvent,
  type AttachmentMeta,
  type Board,
  type BoardEvent,
  type Column,
  type Task,
} from '../../shared/board.js';
import type {
  AttachmentInput,
  CreateTaskFields,
  UpdateTaskFields,
} from './api.js';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

export type BoardSnapshots = {
  board: Board;
  connection: ConnectionStatus;
  lastSyncAt?: number;
};

export type BoardTransport = {
  connect(
    onEvent: (event: BoardEvent) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): void;
  close(): void;
};

export type BoardCommands = {
  fetchBoard(): Promise<Board>;
  createTask(fields: CreateTaskFields): Promise<Task>;
  updateTask(id: string, fields: UpdateTaskFields): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  updateColumns(
    columns: Column[],
    moveTo?: string,
  ): Promise<{ columns: Column[] }>;
  addAttachment(
    taskId: string,
    image: AttachmentInput,
  ): Promise<AttachmentMeta>;
  deleteAttachment(taskId: string, attachmentId: string): Promise<void>;
};

export type BoardSessionOptions = {
  onError?: (error: unknown) => void;
};

export class BoardSession {
  private snapshot: BoardSnapshots = {
    board: { columns: [], projects: [], projectsRevision: 0, tasks: [] },
    connection: 'connecting',
  };

  private readonly listeners = new Set<(snapshot: BoardSnapshots) => void>();
  private started = false;

  constructor(
    private readonly transport: BoardTransport,
    private readonly commands: BoardCommands,
    private readonly options: BoardSessionOptions = {},
  ) {}

  get current(): BoardSnapshots {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: BoardSnapshots) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.transport.connect(
      (event) => {
        this.handleEvent(event);
      },
      (status) => {
        this.setConnection(status);
      },
    );
    void this.refreshInBackground();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.transport.close();
  }

  async refresh(): Promise<void> {
    const board = await this.commands.fetchBoard();
    this.update({ board, lastSyncAt: Date.now() });
  }

  async createTask(fields: CreateTaskFields): Promise<Task> {
    const task = await this.commands.createTask(fields);
    this.handleEvent({ type: 'task_created', task });
    return task;
  }

  async updateTask(id: string, fields: UpdateTaskFields): Promise<Task> {
    const task = await this.commands.updateTask(id, fields);
    this.handleEvent({ type: 'task_updated', task });
    return task;
  }

  async deleteTask(id: string): Promise<void> {
    await this.commands.deleteTask(id);
    this.handleEvent({ type: 'task_deleted', taskId: id });
  }

  async updateColumns(columns: Column[], moveTo?: string): Promise<void> {
    const result = await this.commands.updateColumns(columns, moveTo);
    this.update({
      board: { ...this.snapshot.board, columns: result.columns },
    });
    await this.refresh();
  }

  async addAttachment(
    taskId: string,
    image: AttachmentInput,
  ): Promise<AttachmentMeta> {
    const meta = await this.commands.addAttachment(taskId, image);
    this.changeAttachments(taskId, (list) => [
      ...list.filter((item) => item.id !== meta.id),
      meta,
    ]);
    return meta;
  }

  async deleteAttachment(taskId: string, attachmentId: string): Promise<void> {
    await this.commands.deleteAttachment(taskId, attachmentId);
    this.changeAttachments(taskId, (list) =>
      list.filter((item) => item.id !== attachmentId),
    );
  }

  private changeAttachments(
    taskId: string,
    change: (list: AttachmentMeta[]) => AttachmentMeta[],
  ): void {
    const task = this.snapshot.board.tasks.find((item) => item.id === taskId);
    this.handleEvent({
      type: 'attachments_changed',
      taskId,
      attachments: change(task?.attachments ?? []),
    });
  }

  private setConnection(status: ConnectionStatus): void {
    if (this.snapshot.connection === status) return;
    this.update({ connection: status });
    if (status === 'online') {
      void this.refreshInBackground();
    }
  }

  private handleEvent(event: BoardEvent): void {
    const { board, reload } = applyBoardEvent(this.snapshot.board, event);
    this.update({ board, lastSyncAt: Date.now() });
    if (reload) {
      void this.refreshInBackground();
    }
  }

  private async refreshInBackground(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      this.reportError(error);
    }
  }

  private update(patch: Partial<BoardSnapshots>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error);
  }
}
