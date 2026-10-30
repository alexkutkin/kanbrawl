import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type {
  Column,
  Project,
  SortBy,
  SortOrder,
  Task,
} from '../../../shared/board.js';
import './app-button.js';

// `crypto.randomUUID` is secure-context only, and the board is served over
// plain HTTP on the LAN. The draft id just needs to be unique within the
// dialog; the server assigns the real one when the entry is saved.
function createDraftId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

@customElement('kanbrawl-column-settings')
export class KanbrawlColumnSettings extends LitElement {
  @property({ type: Array }) columns: Column[] = [];
  @property({ type: Array }) projects: Project[] = [];
  @property({ type: Number }) projectsRevision = 0;
  @property({ type: Array }) tasks: Task[] = [];
  @state() private editColumns: Column[] = [];
  @state() private editProjects: Project[] = [];
  @state() private open = false;
  @state() private pending = false;
  @state() private error: string | undefined;
  @state() private moveTo = '';
  private openedProjectsRevision = 0;
  private columnsDirty = false;
  private projectsDirty = false;

  static styles = css`
    :host {
      display: inline-block;
    }

    .settings-btn::part(button) {
      width: 32px;
      min-width: 32px;
      min-height: 32px;
      font-size: 16px;
    }

    dialog.modal {
      width: 420px;
      max-width: calc(100vw - 32px);
      max-height: calc(100dvh - 64px);
      padding: 20px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: var(--bg-surface);
      color: var(--text-primary);
      box-shadow: 0 8px 30px var(--shadow);
      overflow-y: auto;
    }

    dialog.modal[open] {
      animation: slideUp 0.2s ease;
    }

    dialog.modal::backdrop {
      background: rgba(4, 4, 10, 0.62);
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .modal-title {
      font-family: 'Space Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--text-secondary);
      margin: 0 0 8px;
    }

    .modal-hint {
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-muted);
      margin: 0 0 16px;
    }

    .entry-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 12px;
    }

    .entry-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .entry-row input {
      flex: 1;
      min-width: 0;
      padding: 8px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s ease;
      box-sizing: border-box;
    }

    .entry-row input:focus {
      border-color: var(--accent);
    }

    .remove-btn {
      flex-shrink: 0;
    }

    .remove-btn::part(button) {
      min-width: 32px;
      min-height: 32px;
      border: none;
      border-radius: 4px;
      font-size: 14px;
      color: var(--text-dimmed);
    }

    .remove-btn::part(button):hover:enabled {
      color: var(--delete-text);
      background: var(--delete-bg);
    }

    .remove-btn::part(button):disabled {
      opacity: 0.35;
    }

    .add-btn {
      width: 100%;
      margin-bottom: 16px;
    }

    .add-btn::part(button) {
      min-height: 36px;
      padding: 8px;
      border-style: dashed;
      font-size: 12px;
    }

    .projects-section {
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-default);
    }

    .project-task-count {
      flex-shrink: 0;
      align-self: center;
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--text-dimmed);
      background: var(--count-bg);
      padding: 2px 8px;
      border-radius: 10px;
    }

    .folder-row {
      display: flex;
      gap: 6px;
      padding: 0 0 0 32px;
      margin-top: -4px;
    }

    .folder-row input {
      flex: 1;
      min-width: 0;
      padding: 5px 8px;
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: 5px;
      color: var(--text-secondary);
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      outline: none;
      transition: border-color 0.2s ease;
      box-sizing: border-box;
    }

    .folder-row input:focus {
      border-color: var(--accent);
    }

    .folder-label {
      font-size: 11px;
      color: var(--text-dimmed);
      font-family: 'Space Mono', monospace;
      letter-spacing: 0.5px;
      align-self: center;
      flex-shrink: 0;
    }

    .move-note {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: 6px;
      padding: 8px 10px;
      margin-bottom: 12px;
    }

    .move-note select {
      padding: 4px 6px;
      background: var(--bg-surface);
      border: 1px solid var(--border-input);
      border-radius: 5px;
      color: var(--text-primary);
      font-family: 'DM Sans', sans-serif;
      font-size: 12px;
    }

    .form-error {
      font-size: 12px;
      color: var(--error-text);
      margin-bottom: 12px;
    }

    .modal-actions {
      display: flex;
      gap: 8px;
    }

    .modal-actions kanbrawl-button {
      flex: 1;
    }

    .modal-actions .btn-save::part(button):disabled {
      background: var(--btn-disabled-bg);
      color: var(--btn-disabled-text);
      opacity: 1;
    }

    .move-btns {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex-shrink: 0;
    }

    .move-btn::part(button) {
      min-width: 24px;
      min-height: 24px;
      border: none;
      font-size: 10px;
      color: var(--text-dimmed);
    }

    .move-btn::part(button):hover:enabled {
      color: var(--accent);
    }

    .move-btn::part(button):disabled {
      opacity: 0.25;
    }

    .sort-row {
      display: flex;
      gap: 6px;
      padding: 0 0 0 32px;
      margin-top: -4px;
    }

    .sort-row select {
      flex: 1;
      min-width: 0;
      padding: 5px 8px;
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: 5px;
      color: var(--text-secondary);
      font-family: 'DM Sans', sans-serif;
      font-size: 11px;
      outline: none;
      transition: border-color 0.2s ease;
      box-sizing: border-box;
      cursor: pointer;
    }

    .sort-row select:focus {
      border-color: var(--accent);
    }

    .sort-label {
      font-size: 11px;
      color: var(--text-dimmed);
      font-family: 'Space Mono', monospace;
      letter-spacing: 0.5px;
      align-self: center;
      flex-shrink: 0;
    }

    @media (prefers-reduced-motion: reduce) {
      dialog.modal[open] {
        animation: none;
      }
    }
  `;

  private get dialog(): HTMLDialogElement | undefined {
    return (
      this.renderRoot.querySelector<HTMLDialogElement>('dialog.modal') ??
      undefined
    );
  }

  show() {
    this.editColumns = structuredClone(this.columns);
    this.editProjects = structuredClone(this.projects);
    this.openedProjectsRevision = this.projectsRevision;
    this.columnsDirty = false;
    this.projectsDirty = false;
    this.pending = false;
    this.error = undefined;
    this.moveTo = '';
    this.open = true;
    void this.focusDialog();
  }

  private async focusDialog() {
    await this.updateComplete;
    const { dialog } = this;
    if (dialog && !dialog.open) dialog.showModal();
    this.shadowRoot
      ?.querySelector<HTMLInputElement>('.entry-row input')
      ?.focus();
  }

  private close() {
    if (this.pending) return;
    const { dialog } = this;
    if (dialog?.open) {
      dialog.close();
    } else {
      this.open = false;
    }
  }

  private handleDialogClose() {
    this.open = false;
    this.pending = false;
    this.error = undefined;
  }

  private handleDialogClick(e: MouseEvent) {
    const dialog = e.currentTarget as HTMLDialogElement;
    if (e.target !== dialog) return;

    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) this.close();
  }

  private updateColumnName(index: number, value: string) {
    this.columnsDirty = true;
    this.editColumns = this.editColumns.map((column, index_) =>
      index_ === index ? { ...column, name: value } : column,
    );
  }

  private updateSortBy(index: number, value: SortBy) {
    this.columnsDirty = true;
    this.editColumns = this.editColumns.map((column, index_) =>
      index_ === index ? { ...column, sortBy: value } : column,
    );
  }

  private updateSortOrder(index: number, value: SortOrder) {
    this.columnsDirty = true;
    this.editColumns = this.editColumns.map((column, index_) =>
      index_ === index ? { ...column, sortOrder: value } : column,
    );
  }

  private async addColumn() {
    this.columnsDirty = true;
    this.editColumns = [
      ...this.editColumns,
      {
        id: createDraftId(),
        name: '',
        sortBy: 'created',
        sortOrder: 'asc',
      },
    ];
    await this.updateComplete;
    const inputs = this.shadowRoot?.querySelectorAll<HTMLInputElement>(
      '.columns-list input',
    );
    inputs?.[inputs.length - 1]?.focus();
  }

  private removeColumn(index: number) {
    this.columnsDirty = true;
    this.editColumns = this.editColumns.filter((_, index_) => index_ !== index);
    this.syncMoveTo();
  }

  private moveColumn(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= this.editColumns.length) return;
    this.columnsDirty = true;
    const columns = [...this.editColumns];
    [columns[index], columns[target]] = [columns[target], columns[index]];
    this.editColumns = columns;
  }

  private updateProjectName(index: number, value: string) {
    this.projectsDirty = true;
    this.editProjects = this.editProjects.map((project, index_) =>
      index_ === index ? { ...project, name: value } : project,
    );
  }

  private updateProjectFolder(index: number, value: string) {
    this.projectsDirty = true;
    this.editProjects = this.editProjects.map((project, index_) =>
      index_ === index ? { ...project, folder: value } : project,
    );
  }

  private async addProject() {
    this.projectsDirty = true;
    this.editProjects = [
      ...this.editProjects,
      { id: createDraftId(), name: '', folder: '' },
    ];
    await this.updateComplete;
    const inputs = this.shadowRoot?.querySelectorAll<HTMLInputElement>(
      '.projects-list .entry-row input',
    );
    inputs?.[inputs.length - 1]?.focus();
  }

  private removeProject(index: number) {
    this.projectsDirty = true;
    this.editProjects = this.editProjects.filter(
      (_, index_) => index_ !== index,
    );
  }

  /** Tasks currently holding this project; a project with any cannot be removed. */
  private projectTaskCount(project: Project): number {
    return this.tasks.filter((task) => task.projectId === project.id).length;
  }

  private moveProject(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= this.editProjects.length) return;
    this.projectsDirty = true;
    const projects = [...this.editProjects];
    [projects[index], projects[target]] = [projects[target], projects[index]];
    this.editProjects = projects;
  }

  private get removedColumns(): Array<{ column: Column; count: number }> {
    const keptIds = new Set(this.editColumns.map((column) => column.id));
    return this.columns
      .filter((column) => !keptIds.has(column.id))
      .map((column) => ({
        column,
        count: this.tasks.filter((task) => task.column === column.name).length,
      }))
      .filter((entry) => entry.count > 0);
  }

  private syncMoveTo() {
    const candidates = this.editColumns.filter(
      (column) => column.name.trim().length > 0,
    );
    if (!candidates.some((column) => column.name === this.moveTo)) {
      this.moveTo = candidates[0]?.name ?? '';
    }
  }

  private get isValid(): boolean {
    const trimmed = this.editColumns
      .map((column) => column.name.trim())
      .filter((name) => name.length > 0);
    if (trimmed.length === 0) return false;
    if (new Set(trimmed).size !== trimmed.length) return false;

    const projectNames = this.editProjects
      .map((project) => project.name.trim())
      .filter((name) => name.length > 0);
    return new Set(projectNames).size === projectNames.length;
  }

  private async save() {
    if (this.pending || !this.isValid) return;
    this.syncMoveTo();

    const columns = this.editColumns
      .filter((column) => column.name.trim().length > 0)
      .map((column) => ({ ...column, name: column.name.trim() }));
    const moveTo = this.removedColumns.length > 0 ? this.moveTo : undefined;
    // Draft ids of projects added in this dialog are local only: the server
    // mints the real id and rejects unknown ones, so they are not sent.
    const knownProjectIds = new Set(this.projects.map((project) => project.id));
    const projects = this.editProjects
      .filter((project) => project.name.trim().length > 0)
      .map((project) => {
        const entry = { ...project, name: project.name.trim() };
        return knownProjectIds.has(entry.id)
          ? entry
          : { name: entry.name, folder: entry.folder };
      });

    this.pending = true;
    this.error = undefined;
    // An untouched column list is not written back at all, so saving projects
    // cannot overwrite somebody else's concurrent column changes.
    if (this.columnsDirty) {
      const columnsError = await this.dispatchChange('update-columns', {
        columns,
        moveTo,
      });
      if (columnsError !== undefined) {
        this.pending = false;
        this.error = columnsError;
        return;
      }
    }

    // The UI always sends the revision the draft was based on, so a
    // concurrent change is rejected with CONFLICT instead of being
    // overwritten. An untouched project list is not written back at all.
    if (this.projectsDirty) {
      const projectsError = await this.dispatchChange('update-projects', {
        projects,
        expectedRevision: this.openedProjectsRevision,
      });
      if (projectsError !== undefined) {
        this.pending = false;
        this.error = projectsError;
        return;
      }
    }

    this.pending = false;

    const { dialog } = this;
    if (dialog?.open) dialog.close();
    else this.open = false;
  }

  private async dispatchChange(
    type: string,
    detail: Record<string, unknown>,
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.dispatchEvent(
        new CustomEvent(type, {
          detail: {
            ...detail,
            resolve() {
              resolve(undefined);
            },
            reject(message: string) {
              resolve(message);
            },
          },
          bubbles: true,
          composed: true,
        }),
      );
    });
  }

  private renderMoveNote() {
    const removed = this.removedColumns;
    if (removed.length === 0) return nothing;
    const total = removed.reduce((sum, entry) => sum + entry.count, 0);
    return html`
      <div class="move-note">
        <span
          >${total} ${total === 1 ? 'task' : 'tasks'} from removed
          ${removed.map((entry) => entry.column.name).join(', ')} will move
          to</span
        >
        <select
          aria-label="Destination column for tasks from removed columns"
          .value=${this.moveTo}
          @change=${(e: Event) => {
            this.moveTo = (e.target as HTMLSelectElement).value;
          }}
        >
          ${this.editColumns
            .filter((column) => column.name.trim().length > 0)
            .map(
              (column) =>
                html`<option value=${column.name}>${column.name}</option>`,
            )}
        </select>
      </div>
    `;
  }

  render() {
    return html`
      <kanbrawl-button
        class="settings-btn"
        variant="outline"
        icon
        title="Configure columns and projects"
        aria-label="Configure columns and projects"
        @click=${this.show}
      >
        ⚙
      </kanbrawl-button>
      ${this.open
        ? html`
            <dialog
              class="modal"
              aria-labelledby="columns-dialog-title"
              @click=${this.handleDialogClick}
              @close=${this.handleDialogClose}
              @cancel=${(e: Event) => {
                if (this.pending) e.preventDefault();
              }}
            >
              <h2 class="modal-title" id="columns-dialog-title">Columns</h2>
              <p class="modal-hint">
                Agents refer to columns by name. Renaming a column changes the
                name they must use; tasks stay where they are.
              </p>
              <div class="entry-list columns-list">
                ${this.editColumns.map(
                  (column, index) => html`
                    <div class="entry-row">
                      <div class="move-btns">
                        <kanbrawl-button
                          class="move-btn"
                          variant="ghost"
                          icon
                          size="sm"
                          ?disabled=${index === 0 || this.pending}
                          @click=${() => {
                            this.moveColumn(index, -1);
                          }}
                          title="Move up"
                          aria-label="Move ${column.name || 'column'} up"
                        >
                          ▲
                        </kanbrawl-button>
                        <kanbrawl-button
                          class="move-btn"
                          variant="ghost"
                          icon
                          size="sm"
                          ?disabled=${index === this.editColumns.length - 1 ||
                          this.pending}
                          @click=${() => {
                            this.moveColumn(index, 1);
                          }}
                          title="Move down"
                          aria-label="Move ${column.name || 'column'} down"
                        >
                          ▼
                        </kanbrawl-button>
                      </div>
                      <input
                        type="text"
                        .value=${column.name}
                        placeholder="Column name"
                        aria-label="Column name"
                        ?disabled=${this.pending}
                        @input=${(e: InputEvent) => {
                          this.updateColumnName(
                            index,
                            (e.target as HTMLInputElement).value,
                          );
                        }}
                      />
                      <kanbrawl-button
                        class="remove-btn"
                        variant="danger-outline"
                        icon
                        ?disabled=${this.editColumns.length <= 1 ||
                        this.pending}
                        @click=${() => {
                          this.removeColumn(index);
                        }}
                        title="Remove column"
                        aria-label="Remove ${column.name || 'column'}"
                      >
                        ✕
                      </kanbrawl-button>
                    </div>
                    <div class="sort-row">
                      <span class="sort-label">Sort</span>
                      <select
                        .value=${column.sortBy}
                        ?disabled=${this.pending}
                        aria-label="Sort field for ${column.name || 'column'}"
                        @change=${(e: Event) => {
                          this.updateSortBy(
                            index,
                            (e.target as HTMLSelectElement).value as SortBy,
                          );
                        }}
                      >
                        <option value="priority">Priority</option>
                        <option value="created">Created</option>
                        <option value="updated">Updated</option>
                      </select>
                      <select
                        .value=${column.sortOrder}
                        ?disabled=${this.pending}
                        aria-label="Sort order for ${column.name || 'column'}"
                        @change=${(e: Event) => {
                          this.updateSortOrder(
                            index,
                            (e.target as HTMLSelectElement).value as SortOrder,
                          );
                        }}
                      >
                        <option value="asc">Ascending</option>
                        <option value="desc">Descending</option>
                      </select>
                    </div>
                  `,
                )}
              </div>
              <kanbrawl-button
                class="add-btn"
                variant="outline"
                block
                ?disabled=${this.pending}
                @click=${this.addColumn}
              >
                + Add column
              </kanbrawl-button>
              ${this.renderMoveNote()}
              <section class="projects-section">
                <h2 class="modal-title" id="projects-dialog-title">Projects</h2>
                <p class="modal-hint">
                  Projects group work around one code base. The folder is plain
                  metadata: the server stores it as given and never checks the
                  filesystem. Agents manage the same list over MCP.
                </p>
                <div class="entry-list projects-list">
                  ${this.editProjects.map((project, index) => {
                    const taskCount = this.projectTaskCount(project);
                    return html`
                      <div class="entry-row">
                        <div class="move-btns">
                          <kanbrawl-button
                            class="move-btn"
                            variant="ghost"
                            icon
                            size="sm"
                            ?disabled=${index === 0 || this.pending}
                            @click=${() => {
                              this.moveProject(index, -1);
                            }}
                            title="Move up"
                            aria-label="Move ${project.name || 'project'} up"
                          >
                            ▲
                          </kanbrawl-button>
                          <kanbrawl-button
                            class="move-btn"
                            variant="ghost"
                            icon
                            size="sm"
                            ?disabled=${index ===
                              this.editProjects.length - 1 || this.pending}
                            @click=${() => {
                              this.moveProject(index, 1);
                            }}
                            title="Move down"
                            aria-label="Move ${project.name || 'project'} down"
                          >
                            ▼
                          </kanbrawl-button>
                        </div>
                        <input
                          type="text"
                          .value=${project.name}
                          placeholder="Project name"
                          aria-label="Project name"
                          ?disabled=${this.pending}
                          @input=${(e: InputEvent) => {
                            this.updateProjectName(
                              index,
                              (e.target as HTMLInputElement).value,
                            );
                          }}
                        />
                        <span
                          class="project-task-count"
                          title="${taskCount} task(s) in this project"
                          >${taskCount}</span
                        >
                        <kanbrawl-button
                          class="remove-btn"
                          variant="danger-outline"
                          icon
                          ?disabled=${this.pending || taskCount > 0}
                          @click=${() => {
                            this.removeProject(index);
                          }}
                          title=${taskCount > 0
                            ? `Move its ${taskCount} task(s) to another project first`
                            : 'Remove project'}
                          aria-label="Remove ${project.name || 'project'}"
                        >
                          ✕
                        </kanbrawl-button>
                      </div>
                      <div class="folder-row">
                        <span class="folder-label">Folder</span>
                        <input
                          type="text"
                          .value=${project.folder}
                          placeholder="Path to the project code folder"
                          aria-label="Project folder"
                          ?disabled=${this.pending}
                          @input=${(e: InputEvent) => {
                            this.updateProjectFolder(
                              index,
                              (e.target as HTMLInputElement).value,
                            );
                          }}
                        />
                      </div>
                    `;
                  })}
                </div>
                <kanbrawl-button
                  class="add-btn"
                  variant="outline"
                  block
                  ?disabled=${this.pending}
                  @click=${this.addProject}
                >
                  + Add project
                </kanbrawl-button>
              </section>
              ${this.error
                ? html`<div class="form-error" role="alert">${this.error}</div>`
                : nothing}
              <div class="modal-actions">
                <kanbrawl-button
                  class="btn-save"
                  variant="primary"
                  ?disabled=${!this.isValid || this.pending}
                  @click=${this.save}
                >
                  ${this.pending ? 'Saving…' : 'Save'}
                </kanbrawl-button>
                <kanbrawl-button
                  class="btn-cancel"
                  variant="secondary"
                  ?disabled=${this.pending}
                  @click=${this.close}
                >
                  Cancel
                </kanbrawl-button>
              </div>
            </dialog>
          `
        : nothing}
    `;
  }
}
