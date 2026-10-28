import { describe, it, expect, vi } from 'vitest';
import type {
  AttachmentMeta,
  Board,
  BoardEvent,
  Column,
  Task,
} from '../../shared/board.js';
import { ApiError } from './api.js';
import {
  BoardSession,
  type BoardCommands,
  type BoardSnapshots,
  type BoardTransport,
  type ConnectionStatus,
} from './board-session.js';

class FakeTransport implements BoardTransport {
  onEvent: ((event: BoardEvent) => void) | undefined;
  onStatus: ((status: ConnectionStatus) => void) | undefined;
  connectCalls = 0;
  closeCalls = 0;

  connect(
    onEvent: (event: BoardEvent) => void,
    onStatus: (status: ConnectionStatus) => void,
  ): void {
    this.connectCalls += 1;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
  }

  close(): void {
    this.closeCalls += 1;
    this.onEvent = undefined;
    this.onStatus = undefined;
  }

  emit(event: BoardEvent): void {
    this.onEvent?.(event);
  }

  setStatus(status: ConnectionStatus): void {
    this.onStatus?.(status);
  }
}

const TODO: Column = {
  id: 'col-todo',
  name: 'Todo',
  sortBy: 'priority',
  sortOrder: 'asc',
};

function makeBoard(tasks: Task[] = []): Board {
  return { columns: [TODO], tasks };
}

function makeTask(id: string, title = `Task ${id}`): Task {
  return {
    id,
    title,
    description: '',
    column: 'Todo',
    priority: 'P1',
    assignee: '',
    lastActor: 'web',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    attachments: [],
  };
}

function makeAttachment(
  id: string,
  taskId: string,
  filename = `${id}.png`,
): AttachmentMeta {
  return {
    id,
    taskId,
    filename,
    mimeType: 'image/png',
    size: 8,
    sha256: `hash-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeCommands(board = makeBoard()) {
  return {
    fetchBoard: vi.fn(async () => board),
    createTask: vi.fn(async (fields: { title: string }) =>
      makeTask('created', fields.title),
    ),
    updateTask: vi.fn(async (id: string, fields: { title?: string }) =>
      makeTask(id, fields.title),
    ),
    deleteTask: vi.fn(async () => undefined),
    updateColumns: vi.fn(async (columns: Column[]) => ({ columns })),
    addAttachment: vi.fn(async (taskId: string) =>
      makeAttachment('img-1', taskId),
    ),
    deleteAttachment: vi.fn(async () => undefined),
  } satisfies BoardCommands;
}

async function startSession(
  transport = new FakeTransport(),
  commands = makeCommands(),
  onError?: (error: unknown) => void,
) {
  const session = new BoardSession(transport, commands, { onError });
  session.start();
  await vi.waitFor(() => {
    expect(session.current.lastSyncAt).toBeTypeOf('number');
  });
  return { session, transport, commands };
}

describe('BoardSession', () => {
  it('connects the transport and loads the board', async () => {
    const { session, transport, commands } = await startSession();

    expect(transport.connectCalls).toBe(1);
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(1);
    });
    expect(session.current.board).toEqual(makeBoard());
    expect(session.current.lastSyncAt).toBeTypeOf('number');
  });

  it('publishes the current snapshot to new subscribers', async () => {
    const { session } = await startSession();
    const seen: BoardSnapshots[] = [];

    const unsubscribe = session.subscribe((snapshot) => seen.push(snapshot));
    expect(seen).toHaveLength(1);
    expect(seen[0].connection).toBe('connecting');

    unsubscribe();
    session.stop();
  });

  it('maps transport status onto the snapshot', async () => {
    const { session, transport } = await startSession();
    const seen: BoardSnapshots[] = [];
    session.subscribe((snapshot) => seen.push(snapshot));

    transport.setStatus('online');
    expect(seen.at(-1)?.connection).toBe('online');

    transport.setStatus('connecting');
    expect(seen.at(-1)?.connection).toBe('connecting');

    transport.setStatus('offline');
    expect(seen.at(-1)?.connection).toBe('offline');
  });

  it('refetches the board when the stream opens', async () => {
    const { transport, commands } = await startSession();
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(1);
    });

    transport.setStatus('online');
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(2);
    });
  });

  it('applies task events with deduplication', async () => {
    const { session, transport } = await startSession();
    await vi.waitFor(() => {
      expect(session.current.board.tasks).toEqual([]);
    });

    transport.emit({ type: 'task_created', task: makeTask('a') });
    expect(session.current.board.tasks.map((task) => task.id)).toEqual(['a']);

    transport.emit({ type: 'task_created', task: makeTask('a', 'Renamed') });
    expect(session.current.board.tasks).toHaveLength(1);
    expect(session.current.board.tasks[0].title).toBe('Renamed');

    transport.emit({
      type: 'task_deleted',
      taskId: 'a',
    });
    expect(session.current.board.tasks).toEqual([]);
  });

  it('refetches the board after a column event', async () => {
    const { session, transport, commands } = await startSession();
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(1);
    });

    transport.emit({ type: 'columns_updated', columns: [TODO] });
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(2);
    });
  });

  it('applies a created task locally after the command succeeds', async () => {
    const { session, commands } = await startSession();
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(1);
    });

    const task = await session.createTask({ title: 'New' });
    expect(commands.createTask).toHaveBeenCalledWith({ title: 'New' });
    expect(task.title).toBe('New');
    expect(session.current.board.tasks.map((item) => item.id)).toEqual([
      'created',
    ]);
  });

  it('applies an updated task locally', async () => {
    const { session, transport, commands } = await startSession();
    transport.emit({ type: 'task_created', task: makeTask('a') });

    await session.updateTask('a', { title: 'Renamed' });
    expect(commands.updateTask).toHaveBeenCalledWith('a', { title: 'Renamed' });
    expect(session.current.board.tasks[0].title).toBe('Renamed');
  });

  it('removes a deleted task locally', async () => {
    const { session, transport, commands } = await startSession();
    transport.emit({ type: 'task_created', task: makeTask('a') });

    await session.deleteTask('a');
    expect(commands.deleteTask).toHaveBeenCalledWith('a');
    expect(session.current.board.tasks).toEqual([]);
  });

  it('adds an attachment locally without touching other fields', async () => {
    const task = makeTask('task-1');
    const { session, commands } = await startSession(
      new FakeTransport(),
      makeCommands(makeBoard([task])),
    );

    const meta = await session.addAttachment('task-1', {
      name: 'shot.png',
      body: new Uint8Array([1]),
    });
    expect(commands.addAttachment).toHaveBeenCalledWith('task-1', {
      name: 'shot.png',
      body: new Uint8Array([1]),
    });
    expect(session.current.board.tasks[0].attachments).toEqual([meta]);
    expect(session.current.board.tasks[0].updatedAt).toBe(task.updatedAt);
  });

  it('deletes an attachment locally', async () => {
    const task = makeTask('task-1');
    task.attachments = [makeAttachment('img-1', 'task-1')];
    const { session, commands } = await startSession(
      new FakeTransport(),
      makeCommands(makeBoard([task])),
    );

    await session.deleteAttachment('task-1', 'img-1');
    expect(commands.deleteAttachment).toHaveBeenCalledWith('task-1', 'img-1');
    expect(session.current.board.tasks[0].attachments).toEqual([]);
  });

  it('replaces columns and refetches after a column update', async () => {
    const { session, commands } = await startSession();
    await vi.waitFor(() => {
      expect(commands.fetchBoard).toHaveBeenCalledTimes(1);
    });

    const columns = [{ ...TODO, name: 'Backlog' }];
    await session.updateColumns(columns, 'Backlog');
    expect(commands.updateColumns).toHaveBeenCalledWith(columns, 'Backlog');
    expect(commands.fetchBoard).toHaveBeenCalledTimes(2);
  });

  it('propagates command errors without touching the board', async () => {
    const commands = makeCommands();
    commands.updateTask.mockRejectedValueOnce(
      new ApiError('conflict', 'CONFLICT'),
    );
    const { session, transport } = await startSession(
      new FakeTransport(),
      commands,
    );
    transport.emit({ type: 'task_created', task: makeTask('a') });

    await expect(session.updateTask('a', { title: 'x' })).rejects.toMatchObject(
      {
        code: 'CONFLICT',
      },
    );
    expect(session.current.board.tasks[0].title).toBe('Task a');
  });

  it('reports background refresh failures', async () => {
    const commands = makeCommands();
    commands.fetchBoard.mockRejectedValueOnce(new Error('offline'));
    const onError = vi.fn();
    const session = new BoardSession(new FakeTransport(), commands, {
      onError,
    });
    session.start();

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('stops and restarts the transport', async () => {
    const { session, transport } = await startSession();
    session.stop();
    expect(transport.closeCalls).toBe(1);

    session.start();
    expect(transport.connectCalls).toBe(2);
    session.stop();
  });
});
