import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Project, Task } from '../../../shared/board.js';
import { type TaskFilter, filterSummary } from '../task-filter.js';

/**
 * Quick-filter chips above the board: one toggle per project plus a "Show
 * all" master toggle. Purely presentational — the filter state lives in the
 * app and arrives as a property; actions leave as DOM events.
 */
@customElement('kanbrawl-filter-bar')
export class KanbrawlFilterBar extends LitElement {
  @property({ type: Array }) projects: Project[] = [];
  @property({ type: Array }) tasks: Array<Pick<Task, 'projectId'>> = [];
  @property({ type: Object }) filter: TaskFilter = { mode: 'all' };
  @property({ type: Number }) hiddenCount = 0;
  @property({ type: Number }) unclassifiedCount = 0;

  static override styles = css`
    :host {
      display: block;
    }

    .filter-bar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      padding: 8px 0;
    }

    .chips {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }

    .chip {
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 12px;
      border: 1px solid var(--border-input);
      background: var(--bg-input);
      color: var(--text-secondary);
      cursor: pointer;
      transition:
        border-color 0.2s ease,
        color 0.2s ease,
        background 0.2s ease;
    }

    .chip:hover {
      border-color: var(--accent);
    }

    .chip.is-off {
      opacity: 0.55;
      text-decoration: line-through;
    }

    .chip.is-master {
      font-family: 'Space Mono', monospace;
      letter-spacing: 0.3px;
    }

    .filter-status {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--text-dimmed);
      letter-spacing: 0.3px;
    }

    .filter-empty {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border: 1px dashed var(--border-input);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .empty-action {
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--accent);
      background: transparent;
      color: var(--accent);
      cursor: pointer;
    }
  `;

  private chipPressed(projectId: string): boolean {
    return this.filter.mode === 'all' || this.filter.ids.includes(projectId);
  }

  private emit(name: string, detail?: string): void {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }

  override render() {
    const taskCounts = new Map<string, number>();
    for (const task of this.tasks) {
      if (task.projectId !== undefined) {
        taskCounts.set(
          task.projectId,
          (taskCounts.get(task.projectId) ?? 0) + 1,
        );
      }
    }

    const projects = this.projects
      .map((project) => ({ project, count: taskCounts.get(project.id) ?? 0 }))
      .sort(
        (a, b) =>
          b.count - a.count || a.project.name.localeCompare(b.project.name),
      );
    const summary = filterSummary(
      this.filter,
      this.projects.map((project) => project.id),
    );
    return html`
      <div class="filter-bar" role="group" aria-label="Quick filters">
        <button
          type="button"
          class="chip is-master"
          aria-pressed=${summary === 'all'}
          @click=${() => {
            this.emit('toggle-all');
          }}
        >
          Show all
        </button>
        <span class="chips">
          ${projects.map(
            ({ project, count }) => html`
              <button
                type="button"
                class="chip ${this.chipPressed(project.id)
                  ? 'is-on'
                  : 'is-off'}"
                aria-pressed=${this.chipPressed(project.id)}
                title="Show tasks of ${project.name}"
                @click=${() => {
                  this.emit('toggle-project', project.id);
                }}
              >
                ${project.name} (${count})
              </button>
            `,
          )}
        </span>
        <span class="filter-status" role="status">
          ${this.hiddenCount > 0
            ? html`${this.hiddenCount} hidden`
            : nothing}${this.hiddenCount > 0 && this.unclassifiedCount > 0
            ? ' · '
            : nothing}${this.unclassifiedCount > 0
            ? html`${this.unclassifiedCount} without a project`
            : nothing}
        </span>
      </div>
      ${summary === 'none'
        ? html`
            <div class="filter-empty" role="status">
              <span>
                Every project is switched off — project tasks are hidden. Tasks
                without a project stay visible.
              </span>
              <button
                type="button"
                class="empty-action"
                @click=${() => {
                  this.emit('show-all');
                }}
              >
                Show all
              </button>
            </div>
          `
        : nothing}
    `;
  }
}
