import { describe, it, expect } from 'vitest';
import type { Task } from '../../shared/board.js';
import { transition, type TaskDialogState } from './task-dialog.js';

const TASK: Task = {
  id: 'task-1',
  title: 'Fix the bug',
  description: 'Details',
  column: 'Todo',
  priority: 'P0',
  assignee: 'alice',
  lastActor: 'web',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const VIEW: TaskDialogState = { mode: 'view', taskId: TASK.id };

const EDIT: TaskDialogState = {
  mode: 'edit',
  base: TASK,
  fields: {
    title: TASK.title,
    description: TASK.description,
    priority: TASK.priority,
    assignee: TASK.assignee,
  },
  pending: false,
};

const CREATE: TaskDialogState = {
  mode: 'create',
  column: 'Todo',
  fields: { title: 'New', description: '', priority: 'P1', assignee: '' },
  pending: false,
};

describe('task dialog transition', () => {
  it('opens a task view', () => {
    expect(
      transition({ mode: 'closed' }, { type: 'openView', taskId: 'a' }),
    ).toEqual({ mode: 'view', taskId: 'a' });
  });

  it('starts a create with empty fields in the given column', () => {
    const state = transition(
      { mode: 'closed' },
      {
        type: 'openCreate',
        column: 'Blocked',
      },
    );

    expect(state).toEqual({
      mode: 'create',
      column: 'Blocked',
      fields: { title: '', description: '', priority: 'P1', assignee: '' },
      pending: false,
    });
  });

  it('starts editing from the view with the task as the base and seed', () => {
    const state = transition(VIEW, { type: 'startEdit', task: TASK });

    expect(state).toEqual({
      mode: 'edit',
      base: TASK,
      fields: {
        title: 'Fix the bug',
        description: 'Details',
        priority: 'P0',
        assignee: 'alice',
      },
      pending: false,
    });
  });

  it('ignores startEdit outside a view', () => {
    expect(transition(CREATE, { type: 'startEdit', task: TASK })).toBe(CREATE);
  });

  it('patches form fields', () => {
    const state = transition(EDIT, {
      type: 'change',
      patch: { title: 'Renamed' },
    });

    expect(state.mode).toBe('edit');
    expect(
      (state as Extract<TaskDialogState, { mode: 'edit' }>).fields.title,
    ).toBe('Renamed');
  });

  it('changes the target column only while creating', () => {
    const created = transition(CREATE, {
      type: 'change',
      patch: { column: 'Done' },
    });
    expect(created.mode === 'create' && created.column).toBe('Done');

    const edited = transition(EDIT, {
      type: 'change',
      patch: { column: 'Done' },
    });
    expect(edited).toEqual(EDIT);
  });

  it('ignores changes outside a form and while pending', () => {
    expect(transition(VIEW, { type: 'change', patch: { title: 'x' } })).toBe(
      VIEW,
    );

    const pending = transition(EDIT, { type: 'submit' });
    expect(transition(pending, { type: 'change', patch: { title: 'x' } })).toBe(
      pending,
    );
  });

  it('marks the form pending on submit and collapses a double submit', () => {
    const pending = transition(EDIT, { type: 'submit' });
    expect(pending.mode === 'edit' && pending.pending).toBe(true);
    expect(transition(pending, { type: 'submit' })).toBe(pending);

    expect(transition(VIEW, { type: 'submit' })).toBe(VIEW);
  });

  it('clears pending and records the error on failure', () => {
    const failed = transition(transition(CREATE, { type: 'submit' }), {
      type: 'fail',
      message: 'Conflict',
    });

    expect(failed.mode === 'create' && failed.pending).toBe(false);
    expect(failed.mode === 'create' && failed.error).toBe('Conflict');

    expect(transition(VIEW, { type: 'fail', message: 'x' })).toBe(VIEW);
  });

  it('returns to the view after a successful edit', () => {
    const pending = transition(EDIT, { type: 'submit' });
    expect(transition(pending, { type: 'succeed' })).toEqual({
      mode: 'view',
      taskId: TASK.id,
    });
  });

  it('closes after a successful create', () => {
    expect(transition(CREATE, { type: 'succeed' })).toEqual({ mode: 'closed' });
  });

  it('returns an edited task to its view and closes a cancelled create', () => {
    expect(transition(EDIT, { type: 'cancel' })).toEqual(VIEW);
    expect(transition(CREATE, { type: 'cancel' })).toEqual({ mode: 'closed' });
    expect(transition(VIEW, { type: 'cancel' })).toBe(VIEW);
  });

  it('does not cancel while pending', () => {
    const pending = transition(EDIT, { type: 'submit' });
    expect(transition(pending, { type: 'cancel' })).toBe(pending);
  });

  it('closes from any mode', () => {
    const states: TaskDialogState[] = [
      { mode: 'closed' },
      VIEW,
      EDIT,
      CREATE,
      transition(EDIT, { type: 'submit' }),
    ];

    for (const state of states) {
      expect(transition(state, { type: 'close' })).toEqual({ mode: 'closed' });
    }
  });

  it('closes the matching view or edit when its task disappears', () => {
    expect(transition(VIEW, { type: 'taskRemoved', taskId: TASK.id })).toEqual({
      mode: 'closed',
    });
    expect(transition(EDIT, { type: 'taskRemoved', taskId: TASK.id })).toEqual({
      mode: 'closed',
    });
    expect(transition(VIEW, { type: 'taskRemoved', taskId: 'other' })).toBe(
      VIEW,
    );
  });
});
