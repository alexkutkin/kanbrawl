import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  compareTasks,
  type Task,
  type SortBy,
  type SortOrder,
} from '../../../shared/board.js';

@customElement('kanbrawl-column')
export class KanbrawlColumn extends LitElement {
  @property() name = '';
  @property({ type: Array }) tasks: Task[] = [];
  @property({ type: Array }) allColumns: string[] = [];
  @property({ type: Object }) staleIds = new Set<string>();
  @property() sortBy: SortBy = 'created';
  @property() sortOrder: SortOrder = 'asc';
  @state() private dragOver = false;
  @state() private folded = false;
  @state() private dropHint: string | undefined;

  private hintTimer: ReturnType<typeof setTimeout> | undefined;

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      overflow: hidden;
      transition:
        background 0.3s ease,
        border-color 0.3s ease,
        flex 0.3s ease,
        min-width 0.3s ease,
        width 0.3s ease;
    }

    :host(.drag-over) {
      border-color: var(--accent);
      background: var(--accent-bg);
    }

    /* ── Folded state (desktop) ── */
    :host(.folded) {
      min-width: 0 !important;
      width: 44px;
      flex: 0 0 44px;
      cursor: pointer;
    }

    .folded-view {
      display: none;
      flex-direction: column;
      align-items: center;
      height: 100%;
      padding: 6px 0;
      gap: 10px;
      box-sizing: border-box;
    }

    :host(.folded) .folded-view {
      display: flex;
    }

    :host(.folded) .column-header,
    :host(.folded) .tasks-list,
    :host(.folded) .add-area {
      display: none;
    }

    .folded-title {
      writing-mode: vertical-rl;
      text-orientation: mixed;
      transform: rotate(180deg);
      font-family: 'Space Mono', monospace;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--text-secondary);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .folded-count {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--count-text);
      background: var(--count-bg);
      padding: 3px 6px;
      border-radius: 10px;
      min-width: 20px;
      text-align: center;
    }

    .fold-btn {
      background: none;
      border: none;
      color: var(--text-dimmed);
      cursor: pointer;
      min-width: 24px;
      min-height: 24px;
      font-size: 10px;
      line-height: 1;
      flex-shrink: 0;
      transition:
        color 0.15s ease,
        transform 0.3s ease;
    }

    .fold-btn:hover {
      color: var(--accent);
    }

    .fold-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    .fold-btn .caret {
      display: inline-block;
      transition: transform 0.3s ease;
    }

    .fold-btn.is-folded .caret {
      transform: rotate(-90deg);
    }

    .column-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 18px;
      background: var(--bg-column-header);
      border-bottom: 1px solid var(--border-default);
      transition:
        background 0.3s ease,
        border-color 0.3s ease;
      flex-shrink: 0;
    }

    .column-header-left {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .column-header-right {
      margin-left: auto;
    }

    .column-title {
      font-family: 'Space Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--text-secondary);
    }

    .task-count {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--count-text);
      background: var(--count-bg);
      padding: 3px 8px;
      border-radius: 10px;
      min-width: 24px;
      text-align: center;
      transition:
        background 0.3s ease,
        color 0.3s ease;
    }

    .drop-hint {
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--accent-bg);
      border: 1px solid var(--border-input);
      border-radius: 6px;
      padding: 6px 10px;
      margin: 8px 12px 0;
    }

    .tasks-list {
      flex: 1;
      min-height: 60px;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .tasks-list::-webkit-scrollbar {
      width: 4px;
    }

    .tasks-list::-webkit-scrollbar-track {
      background: transparent;
    }

    .tasks-list::-webkit-scrollbar-thumb {
      background: var(--scrollbar);
      border-radius: 2px;
    }

    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px 16px;
      color: var(--empty-text);
      font-size: 13px;
      font-style: italic;
    }

    .add-area {
      padding: 12px;
      border-top: 1px solid var(--border-default);
      transition: border-color 0.3s ease;
      flex-shrink: 0;
    }

    .add-btn {
      width: 100%;
      min-height: 40px;
      padding: 10px;
      background: transparent;
      border: 1px dashed var(--border-input);
      border-radius: 8px;
      color: var(--text-muted);
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .add-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-bg);
    }

    .add-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    @media (max-width: 600px) {
      :host(.folded) {
        width: 100%;
        flex: 0 0 auto;
        min-width: 0 !important;
      }

      .folded-view {
        flex-direction: row;
        height: auto;
        padding: 6px 14px;
        gap: 6px;
        align-items: center;
      }

      .folded-view .fold-btn {
        order: -1;
      }

      .folded-view .folded-count {
        order: 1;
        margin-left: auto;
        padding: 3px 8px;
        min-width: 24px;
      }

      .folded-title {
        writing-mode: horizontal-tb;
        text-orientation: initial;
        transform: none;
        flex: 0 0 auto;
        font-size: 13px;
      }

      .column-header {
        padding: 6px 14px;
      }

      .tasks-list {
        padding: 8px;
      }

      .add-area {
        padding: 8px;
      }

      .add-btn {
        padding: 10px;
        font-size: 14px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host,
      .fold-btn,
      .fold-btn .caret {
        transition: none;
      }
    }
  `;

  // --- Drag & drop ---
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('dragover', this._onDragOver);
    this.addEventListener('dragleave', this._onDragLeave);
    this.addEventListener('drop', this._onDrop);
    this._restoreFoldState();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('dragover', this._onDragOver);
    this.removeEventListener('dragleave', this._onDragLeave);
    this.removeEventListener('drop', this._onDrop);
    if (this.hintTimer) clearTimeout(this.hintTimer);
  }

  private readonly _onDragOver = (e: DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!this.dragOver) {
      this.dragOver = true;
      this.classList.add('drag-over');
    }
  };

  private readonly _onDragLeave = (e: DragEvent) => {
    // Only clear when leaving the host element itself
    const rect = this.getBoundingClientRect();
    if (
      e.clientX <= rect.left ||
      e.clientX >= rect.right ||
      e.clientY <= rect.top ||
      e.clientY >= rect.bottom
    ) {
      this.dragOver = false;
      this.classList.remove('drag-over');
    }
  };

  private readonly _onDrop = (e: DragEvent) => {
    e.preventDefault();
    this.dragOver = false;
    this.classList.remove('drag-over');

    const taskId = e.dataTransfer?.getData('text/plain');
    if (!taskId) return;

    const existingTask = this.tasks.find((t) => t.id === taskId);
    if (existingTask) {
      this.showDropHint(`"${existingTask.title}" is already in ${this.name}.`);
      return;
    }

    this.dispatchEvent(
      new CustomEvent('update-task', {
        detail: { id: taskId, column: this.name },
        bubbles: true,
        composed: true,
      }),
    );
  };

  private showDropHint(message: string) {
    this.dropHint = message;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.dropHint = undefined;
      this.hintTimer = undefined;
    }, 3000);
  }

  private requestCreate() {
    this.dispatchEvent(
      new CustomEvent('create-task-request', {
        detail: { column: this.name },
        bubbles: true,
        composed: true,
      }),
    );
  }

  // --- Fold ---
  private _foldKey(): string {
    return `kanbrawl-fold-${this.name}`;
  }

  private _restoreFoldState() {
    const stored = localStorage.getItem(this._foldKey());
    if (stored === '1') this._setFolded(true);
  }

  private _setFolded(value: boolean) {
    this.folded = value;
    if (value) {
      this.classList.add('folded');
      localStorage.setItem(this._foldKey(), '1');
    } else {
      this.classList.remove('folded');
      localStorage.removeItem(this._foldKey());
    }
  }

  private toggleFold() {
    this._setFolded(!this.folded);
  }

  render() {
    return html`
      <div class="folded-view" @click=${this.toggleFold}>
        <span class="folded-count">${this.tasks.length}</span>
        <span class="folded-title">${this.name}</span>
        <button class="fold-btn is-folded" title="Unfold column">
          <span class="caret">▼</span>
        </button>
      </div>
      <div class="column-header">
        <div class="column-header-left">
          <button
            class="fold-btn"
            @click=${this.toggleFold}
            title="Fold column"
          >
            <span class="caret">▼</span>
          </button>
          <span class="column-title">${this.name}</span>
        </div>
        <span class="task-count column-header-right">${this.tasks.length}</span>
      </div>
      ${this.dropHint
        ? html`<div class="drop-hint" role="status">${this.dropHint}</div>`
        : nothing}
      <div class="tasks-list">
        ${this.tasks.length === 0
          ? html`<div class="empty-state">No tasks</div>`
          : [...this.tasks]
              .sort((a, b) =>
                compareTasks(
                  { sortBy: this.sortBy, sortOrder: this.sortOrder },
                  a,
                  b,
                ),
              )
              .map(
                (task) => html`
                  <kanbrawl-task
                    .task=${task}
                    .allColumns=${this.allColumns}
                    .stale=${this.staleIds.has(task.id)}
                  ></kanbrawl-task>
                `,
              )}
      </div>
      <div class="add-area">
        <button class="add-btn" @click=${this.requestCreate}>+ Add task</button>
      </div>
    `;
  }
}
