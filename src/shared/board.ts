export type Priority = 'P0' | 'P1' | 'P2';

export type SortBy = 'priority' | 'created' | 'updated';
export type SortOrder = 'asc' | 'desc';

export type Column = {
  id: string;
  name: string;
  sortBy: SortBy;
  sortOrder: SortOrder;
};

export type AttachmentMeta = {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

export type Task = {
  id: string;
  title: string;
  description: string;
  column: string;
  priority: Priority;
  assignee: string;
  lastActor: string;
  clientRequestId?: string;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentMeta[];
};

export type Board = {
  columns: Column[];
  tasks: Task[];
  theme?: 'light' | 'dark';
};

export type BoardEvent =
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; task: Task }
  | { type: 'task_moved'; task: Task; fromColumn: string }
  | { type: 'task_deleted'; taskId: string }
  | {
      type: 'attachments_changed';
      taskId: string;
      attachments: AttachmentMeta[];
    }
  | { type: 'columns_updated'; columns: Column[] }
  | { type: 'board_sync'; board: Board };

export const LIMITS = {
  title: 200,
  description: 4000,
  assignee: 100,
  attachmentSize: 10 * 1024 * 1024,
  attachmentsPerTask: 10,
} as const;

const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2 };

export function defaultColumns(makeId: () => string): Column[] {
  return [
    { id: makeId(), name: 'Todo', sortBy: 'priority', sortOrder: 'asc' },
    { id: makeId(), name: 'In progress', sortBy: 'created', sortOrder: 'asc' },
    { id: makeId(), name: 'Blocked', sortBy: 'created', sortOrder: 'asc' },
    { id: makeId(), name: 'Done', sortBy: 'updated', sortOrder: 'desc' },
  ];
}

export function compareTasks(
  column: Pick<Column, 'sortBy' | 'sortOrder'>,
  a: Task,
  b: Task,
): number {
  let cmp = 0;
  switch (column.sortBy) {
    case 'priority': {
      cmp = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      break;
    }

    case 'created': {
      cmp = a.createdAt.localeCompare(b.createdAt);
      break;
    }

    case 'updated': {
      cmp = a.updatedAt.localeCompare(b.updatedAt);
      break;
    }
  }

  return column.sortOrder === 'desc' ? -cmp : cmp;
}

function upsertTask(board: Board, task: Task): Board {
  const exists = board.tasks.some((item) => item.id === task.id);
  return {
    ...board,
    tasks: exists
      ? board.tasks.map((item) => (item.id === task.id ? task : item))
      : [...board.tasks, task],
  };
}

export function applyBoardEvent(
  board: Board,
  event: BoardEvent,
): { board: Board; reload: boolean } {
  switch (event.type) {
    case 'board_sync': {
      return { board: event.board, reload: false };
    }

    case 'task_created':
    case 'task_updated':
    case 'task_moved': {
      return { board: upsertTask(board, event.task), reload: false };
    }

    case 'task_deleted': {
      return {
        board: {
          ...board,
          tasks: board.tasks.filter((task) => task.id !== event.taskId),
        },
        reload: false,
      };
    }

    case 'attachments_changed': {
      return {
        board: {
          ...board,
          tasks: board.tasks.map((task) =>
            task.id === event.taskId
              ? { ...task, attachments: event.attachments }
              : task,
          ),
        },
        reload: false,
      };
    }

    case 'columns_updated': {
      // Column renames and removals move tasks; only a full board has the result.
      return { board, reload: true };
    }
  }
}
