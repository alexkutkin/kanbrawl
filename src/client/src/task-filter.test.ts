import { describe, it, expect } from 'vitest';
import type { Task } from '../../shared/board.js';
import {
  createFilter,
  filterSummary,
  hiddenTaskCount,
  isTaskVisible,
  normalizeFilter,
  removeProjectFromFilter,
  toggleAllProjects,
  toggleProjectFilter,
  unclassifiedTaskCount,
} from './task-filter.js';

const PROJECT_IDS = ['p1', 'p2', 'p3'];

function task(id: string, projectId: string | undefined): Task {
  return {
    id,
    title: `Task ${id}`,
    description: '',
    column: 'Todo',
    priority: 'P1',
    assignee: '',
    lastActor: 'web',
    ...(projectId === undefined ? {} : { projectId }),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    attachments: [],
  };
}

describe('task filter state machine', () => {
  it('starts in all mode where everything is visible', () => {
    const filter = createFilter();
    expect(filter).toEqual({ mode: 'all' });
    expect(filterSummary(filter, PROJECT_IDS)).toBe('all');
    expect(isTaskVisible(filter, task('a', 'p1'))).toBe(true);
    expect(hiddenTaskCount(filter, [task('a', 'p1')])).toBe(0);
  });

  it('toggle-all turns every project off from all and back on otherwise', () => {
    const off = toggleAllProjects(createFilter(), PROJECT_IDS);
    expect(off).toEqual({ mode: 'selected', ids: [] });
    expect(filterSummary(off, PROJECT_IDS)).toBe('none');

    const on = toggleAllProjects(off, PROJECT_IDS);
    expect(on).toEqual({ mode: 'all' });
  });

  it('toggle-all from a partial selection turns every project on', () => {
    const partial = toggleProjectFilter(createFilter(), 'p1', PROJECT_IDS);
    const on = toggleAllProjects(partial, PROJECT_IDS);
    expect(on).toEqual({ mode: 'all' });
  });

  it('toggling one chip in all mode deselects just that project', () => {
    const filter = toggleProjectFilter(createFilter(), 'p2', PROJECT_IDS);
    expect(filter).toEqual({ mode: 'selected', ids: ['p1', 'p3'] });
    expect(filterSummary(filter, PROJECT_IDS)).toBe('partial');
    expect(isTaskVisible(filter, task('a', 'p1'))).toBe(true);
    expect(isTaskVisible(filter, task('b', 'p2'))).toBe(false);
  });

  it('re-selecting the last missing project normalizes to all', () => {
    const missing = toggleProjectFilter(createFilter(), 'p2', PROJECT_IDS);
    const restored = toggleProjectFilter(missing, 'p2', PROJECT_IDS);
    expect(restored).toEqual({ mode: 'all' });
  });

  it('toggling a chip in selected mode turns the project on and off', () => {
    let filter = toggleProjectFilter(createFilter(), 'p2', PROJECT_IDS);
    filter = toggleProjectFilter(filter, 'p3', PROJECT_IDS);
    expect(filter).toEqual({ mode: 'selected', ids: ['p1'] });

    filter = toggleProjectFilter(filter, 'p3', PROJECT_IDS);
    expect(filter).toEqual({ mode: 'selected', ids: ['p1', 'p3'] });
  });

  it('a deleted project disappears from the selection', () => {
    let filter = toggleProjectFilter(createFilter(), 'p3', PROJECT_IDS);
    filter = toggleProjectFilter(filter, 'p2', PROJECT_IDS);
    expect(filter).toEqual({ mode: 'selected', ids: ['p1'] });

    filter = removeProjectFromFilter(filter, 'p1', ['p2', 'p3']);
    expect(filter).toEqual({ mode: 'selected', ids: [] });
  });

  it('unclassified tasks stay visible in every state', () => {
    const off = toggleAllProjects(createFilter(), PROJECT_IDS);
    expect(isTaskVisible(off, task('a', undefined))).toBe(true);

    const filter = toggleProjectFilter(createFilter(), 'p1', PROJECT_IDS);
    expect(isTaskVisible(filter, task('a', undefined))).toBe(true);
    expect(unclassifiedTaskCount([task('a', undefined), task('b', 'p1')])).toBe(
      1,
    );
  });

  it('counts hidden tasks while unclassified ones stay visible', () => {
    let filter = toggleProjectFilter(createFilter(), 'p2', PROJECT_IDS);
    filter = toggleProjectFilter(filter, 'p3', PROJECT_IDS);
    const tasks = [
      task('a', 'p1'),
      task('b', 'p2'),
      task('c', 'p3'),
      task('d', undefined),
    ];
    expect(hiddenTaskCount(filter, tasks)).toBe(2);
    expect(filterSummary(filter, PROJECT_IDS)).toBe('partial');
  });

  it('normalizeFilter is a no-op unless every project is selected', () => {
    expect(normalizeFilter({ mode: 'all' }, PROJECT_IDS)).toEqual({
      mode: 'all',
    });
    expect(
      normalizeFilter({ mode: 'selected', ids: ['p1', 'p2'] }, PROJECT_IDS),
    ).toEqual({ mode: 'selected', ids: ['p1', 'p2'] });
    expect(
      normalizeFilter(
        { mode: 'selected', ids: ['p1', 'p2', 'p3', 'gone'] },
        PROJECT_IDS,
      ),
    ).toEqual({ mode: 'all' });
  });
});
