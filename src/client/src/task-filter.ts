import type { Task } from '../../shared/board.js';

/**
 * Quick-filter state for the project chips above the board.
 *
 * `all` shows every project (and is the default). `selected` keeps an explicit
 * set of visible project ids; selecting every project normalizes back to
 * `all`, so a newly created project becomes visible automatically in `all`
 * mode. Tasks without a project are visible in every state until the
 * classification backfill finishes.
 */
export type TaskFilter = { mode: 'all' } | { mode: 'selected'; ids: string[] };

export type FilterSummary = 'all' | 'partial' | 'none';

export function createFilter(): TaskFilter {
  return { mode: 'all' };
}

/** Selecting every project is equivalent to `all`. */
export function normalizeFilter(
  filter: TaskFilter,
  projectIds: string[],
): TaskFilter {
  if (filter.mode === 'all') return filter;
  const selected = new Set(filter.ids);
  if (projectIds.length > 0 && projectIds.every((id) => selected.has(id))) {
    return { mode: 'all' };
  }

  return filter;
}

/**
 * The "Show all" master toggle: from `all` it turns every project off (an
 * explicit empty selection), otherwise it turns every project on.
 */
export function toggleAllProjects(
  filter: TaskFilter,
  projectIds: string[],
): TaskFilter {
  if (filter.mode === 'all') {
    return { mode: 'selected', ids: [] };
  }

  return normalizeFilter(
    { mode: 'selected', ids: [...projectIds] },
    projectIds,
  );
}

/** Toggles one project chip. In `all` mode the first click deselects it. */
export function toggleProjectFilter(
  filter: TaskFilter,
  projectId: string,
  projectIds: string[],
): TaskFilter {
  const current =
    filter.mode === 'all'
      ? projectIds.filter((id) => id !== projectId)
      : filter.ids.includes(projectId)
        ? filter.ids.filter((id) => id !== projectId)
        : [...filter.ids, projectId];

  return normalizeFilter({ mode: 'selected', ids: current }, projectIds);
}

/** A deleted project must disappear from the selection. */
export function removeProjectFromFilter(
  filter: TaskFilter,
  projectId: string,
  projectIds: string[],
): TaskFilter {
  if (filter.mode === 'all') return filter;
  return normalizeFilter(
    { mode: 'selected', ids: filter.ids.filter((id) => id !== projectId) },
    projectIds,
  );
}

/**
 * A task is hidden only when it has a project that the filter excludes;
 * unclassified tasks stay visible regardless of the filter.
 */
export function isTaskVisible(filter: TaskFilter, task: Task): boolean {
  if (task.projectId === undefined) return true;
  if (filter.mode === 'all') return true;
  return filter.ids.includes(task.projectId);
}

export function filterSummary(
  filter: TaskFilter,
  projectIds: string[],
): FilterSummary {
  const normalized = normalizeFilter(filter, projectIds);
  if (normalized.mode === 'all') return 'all';
  return normalized.ids.length === 0 ? 'none' : 'partial';
}

export function hiddenTaskCount(filter: TaskFilter, tasks: Task[]): number {
  return tasks.filter((task) => !isTaskVisible(filter, task)).length;
}

export function unclassifiedTaskCount(tasks: Task[]): number {
  return tasks.filter((task) => task.projectId === undefined).length;
}
