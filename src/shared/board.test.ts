import { describe, expect, it } from 'vitest';
import {
  applyBoardEvent,
  compareTasks,
  defaultColumns,
  type Board,
  type Task,
} from './board.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Task',
    description: '',
    column: 'Todo',
    priority: 'P1',
    assignee: '',
    lastActor: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    attachments: [],
    ...overrides,
  };
}

function makeBoard(tasks: Task[] = []): Board {
  return {
    columns: [
      { id: 'c1', name: 'Todo', sortBy: 'priority', sortOrder: 'asc' },
      { id: 'c2', name: 'Done', sortBy: 'updated', sortOrder: 'desc' },
    ],
    projects: [],
    projectsRevision: 0,
    tasks,
  };
}

function ids(): () => string {
  let next = 0;
  return () => `column-${++next}`;
}

describe('defaultColumns', () => {
  it('returns the four board columns with the documented sorting', () => {
    expect(defaultColumns(ids())).toEqual([
      { id: 'column-1', name: 'Todo', sortBy: 'priority', sortOrder: 'asc' },
      {
        id: 'column-2',
        name: 'In progress',
        sortBy: 'created',
        sortOrder: 'asc',
      },
      { id: 'column-3', name: 'Blocked', sortBy: 'created', sortOrder: 'asc' },
      { id: 'column-4', name: 'Done', sortBy: 'updated', sortOrder: 'desc' },
    ]);
  });

  it('mints a fresh id for every column', () => {
    const columns = defaultColumns(() => crypto.randomUUID());
    expect(new Set(columns.map((column) => column.id)).size).toBe(4);
  });
});

describe('compareTasks', () => {
  it('orders by priority ranking, not by string', () => {
    const tasks = [
      makeTask({ id: 'p2', priority: 'P2' }),
      makeTask({ id: 'p0', priority: 'P0' }),
      makeTask({ id: 'p1', priority: 'P1' }),
    ];
    const sorted = [...tasks].sort((a, b) =>
      compareTasks({ sortBy: 'priority', sortOrder: 'asc' }, a, b),
    );
    expect(sorted.map((task) => task.id)).toEqual(['p0', 'p1', 'p2']);
  });

  it('reverses the order for desc', () => {
    const tasks = [
      makeTask({ id: 'first', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'second', createdAt: '2026-02-01T00:00:00.000Z' }),
    ];
    const sorted = [...tasks].sort((a, b) =>
      compareTasks({ sortBy: 'created', sortOrder: 'desc' }, a, b),
    );
    expect(sorted.map((task) => task.id)).toEqual(['second', 'first']);
  });

  it('sorts by updated time', () => {
    const tasks = [
      makeTask({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      makeTask({ id: 'new', updatedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    const sorted = [...tasks].sort((a, b) =>
      compareTasks({ sortBy: 'updated', sortOrder: 'asc' }, a, b),
    );
    expect(sorted.map((task) => task.id)).toEqual(['old', 'new']);
  });

  it('keeps the input order for equal keys', () => {
    const tasks = [
      makeTask({ id: 'a' }),
      makeTask({ id: 'b' }),
      makeTask({ id: 'c' }),
    ];
    const sorted = [...tasks].sort((a, b) =>
      compareTasks({ sortBy: 'created', sortOrder: 'asc' }, a, b),
    );
    expect(sorted.map((task) => task.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('applyBoardEvent', () => {
  it('replaces the board on board_sync', () => {
    const synced = makeBoard([makeTask({ id: 'remote' })]);
    expect(
      applyBoardEvent(makeBoard(), { type: 'board_sync', board: synced }),
    ).toEqual({
      board: synced,
      reload: false,
    });
  });

  it('inserts a created task', () => {
    const task = makeTask();
    const result = applyBoardEvent(makeBoard(), {
      type: 'task_created',
      task,
    });
    expect(result.board.tasks).toEqual([task]);
    expect(result.reload).toBe(false);
  });

  it('updates instead of duplicating when the task already exists', () => {
    const original = makeTask();
    const renamed = makeTask({ title: 'Renamed' });
    const result = applyBoardEvent(makeBoard([original]), {
      type: 'task_created',
      task: renamed,
    });
    expect(result.board.tasks).toEqual([renamed]);
  });

  it('replaces a moved task', () => {
    const original = makeTask();
    const moved = makeTask({ column: 'Done' });
    const result = applyBoardEvent(makeBoard([original]), {
      type: 'task_moved',
      task: moved,
      fromColumn: 'Todo',
    });
    expect(result.board.tasks).toEqual([moved]);
  });

  it('removes a deleted task', () => {
    const board = makeBoard([
      makeTask({ id: 'keep' }),
      makeTask({ id: 'drop' }),
    ]);
    const result = applyBoardEvent(board, {
      type: 'task_deleted',
      taskId: 'drop',
    });
    expect(result.board.tasks.map((task) => task.id)).toEqual(['keep']);
  });

  it('asks for a reload when columns change', () => {
    const board = makeBoard();
    const result = applyBoardEvent(board, {
      type: 'columns_updated',
      columns: board.columns,
    });
    expect(result.board).toBe(board);
    expect(result.reload).toBe(true);
  });

  it('asks for a reload when projects change', () => {
    const board = makeBoard();
    const result = applyBoardEvent(board, {
      type: 'projects_updated',
      projects: [{ id: 'p1', name: 'Kanbrawl', folder: '/code/kanbrawl' }],
      revision: 3,
    });
    expect(result.board).toBe(board);
    expect(result.reload).toBe(true);
  });
});
