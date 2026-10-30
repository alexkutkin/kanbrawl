import { LIMITS, type Priority, type Task } from '../../shared/board.js';

export type TaskFields = {
  title: string;
  description: string;
  priority: Priority;
  assignee: string;
  /** Project id; empty string means "not chosen yet" and blocks submission. */
  projectId: string;
};

export type StagedImage = {
  name: string;
  size: number;
  previewUrl: string;
  body: Blob;
};

export type TaskDialogState =
  | { mode: 'closed' }
  | { mode: 'view'; taskId: string }
  | {
      mode: 'edit';
      base: Task;
      fields: TaskFields;
      pending: boolean;
      error?: string;
    }
  | {
      mode: 'create';
      column: string;
      fields: TaskFields;
      images: StagedImage[];
      pending: boolean;
      error?: string;
    };

export type TaskDialogAction =
  | { type: 'openView'; taskId: string }
  | { type: 'openCreate'; column: string }
  | { type: 'startEdit'; task: Task }
  | { type: 'change'; patch: Partial<TaskFields> & { column?: string } }
  | { type: 'stage'; images: StagedImage[] }
  | { type: 'unstage'; index: number }
  | { type: 'submit' }
  | { type: 'fail'; message: string }
  | { type: 'succeed' }
  | { type: 'cancel' }
  | { type: 'close' }
  | { type: 'taskRemoved'; taskId: string };

function fieldsFromTask(task: Task): TaskFields {
  return {
    title: task.title,
    description: task.description,
    priority: task.priority,
    assignee: task.assignee,
    // A task predating the project catalog starts with no project; the edit
    // form must choose one before it can be saved (final-state requiredness).
    projectId: task.projectId ?? '',
  };
}

export function transition(
  state: TaskDialogState,
  action: TaskDialogAction,
): TaskDialogState {
  switch (action.type) {
    case 'openView': {
      return { mode: 'view', taskId: action.taskId };
    }

    case 'openCreate': {
      return {
        mode: 'create',
        column: action.column,
        fields: {
          title: '',
          description: '',
          priority: 'P1',
          assignee: '',
          projectId: '',
        },
        images: [],
        pending: false,
      };
    }

    case 'startEdit': {
      if (state.mode !== 'view' && state.mode !== 'closed') return state;
      return {
        mode: 'edit',
        base: action.task,
        fields: fieldsFromTask(action.task),
        pending: false,
      };
    }

    case 'change': {
      if (state.mode === 'edit') {
        if (state.pending) return state;
        const { column: _column, ...patch } = action.patch;
        return { ...state, fields: { ...state.fields, ...patch } };
      }

      if (state.mode === 'create') {
        if (state.pending) return state;
        const { column, ...patch } = action.patch;
        return {
          ...state,
          column: column ?? state.column,
          fields: { ...state.fields, ...patch },
        };
      }

      return state;
    }

    case 'stage': {
      if (state.mode !== 'create' || state.pending) return state;
      const room = LIMITS.attachmentsPerTask - state.images.length;
      if (room <= 0) return state;
      return {
        ...state,
        images: [...state.images, ...action.images.slice(0, room)],
      };
    }

    case 'unstage': {
      if (state.mode !== 'create' || state.pending) return state;
      if (action.index < 0 || action.index >= state.images.length) return state;
      return {
        ...state,
        images: state.images.filter((_, index) => index !== action.index),
      };
    }

    case 'submit': {
      if (state.mode !== 'edit' && state.mode !== 'create') return state;
      if (state.pending) return state;
      // A task must end up with a project: submission is blocked until one is
      // chosen (same rule for create and for editing an unclassified task).
      if (!state.fields.projectId.trim()) {
        return { ...state, pending: false, error: 'Project is required.' };
      }

      return { ...state, pending: true, error: undefined };
    }

    case 'fail': {
      if (state.mode !== 'edit' && state.mode !== 'create') return state;
      return { ...state, pending: false, error: action.message };
    }

    case 'succeed': {
      if (state.mode === 'edit') return { mode: 'view', taskId: state.base.id };
      if (state.mode === 'create') return { mode: 'closed' };
      return state;
    }

    case 'cancel': {
      if (state.mode === 'edit') {
        if (state.pending) return state;
        return { mode: 'view', taskId: state.base.id };
      }

      if (state.mode === 'create') {
        if (state.pending) return state;
        return { mode: 'closed' };
      }

      return state;
    }

    case 'close': {
      return { mode: 'closed' };
    }

    case 'taskRemoved': {
      if (state.mode === 'view' && state.taskId === action.taskId) {
        return { mode: 'closed' };
      }

      if (state.mode === 'edit' && state.base.id === action.taskId) {
        return { mode: 'closed' };
      }

      return state;
    }
  }
}
