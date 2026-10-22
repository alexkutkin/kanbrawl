import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { Board, Task, Column } from './types.js';
import {
  fetchBoard,
  createTask,
  updateTask,
  deleteTask,
  updateColumns,
} from './api.js';
import './components/column-settings.js';

type Theme = 'light' | 'dark';

@customElement('kanbrawl-app')
export class KanbrawlApp extends LitElement {
  @state() private board: Board = { columns: [], tasks: [] };
  @state() private connected = false;
  @state() private error: string | undefined = null;
  @state() private theme: Theme = 'dark';
  @state() private selectedTaskId: string | undefined;

  private eventSource: EventSource | undefined = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined = null;
  private reconnectDelay = 1000;
  private previousBodyOverflow: string | undefined;

  private static get MAX_RECONNECT_DELAY() {
    return 30_000;
  }

  private static get BASE_RECONNECT_DELAY() {
    return 1000;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      background: var(--bg-base);
      color: var(--text-primary);
      transition:
        background 0.3s ease,
        color 0.3s ease;

      /* ── Dark theme (default) ── */
      --bg-base: #0a0a0f;
      --bg-surface: #12121c;
      --bg-surface-hover: #1a1a30;
      --bg-elevated: #16162a;
      --bg-elevated-hover: #1e1e36;
      --bg-input: #0e0e18;
      --bg-header: linear-gradient(135deg, #12121a 0%, #1a1a2e 100%);
      --bg-column-header: linear-gradient(180deg, #16162a 0%, #12121c 100%);
      --border-default: #2a2a42;
      --border-subtle: #2e2e48;
      --border-hover: #44446a;
      --border-input: #353550;
      --text-primary: #ebebeb;
      --text-secondary: #a0a0c0;
      --text-muted: #8888aa;
      --text-dimmed: #727292;
      --text-placeholder: #6a6a8e;
      --accent: #ff6b35;
      --accent-hover: #ff8c61;
      --accent-glow: rgba(255, 107, 53, 0.4);
      --accent-bg: rgba(255, 107, 53, 0.08);
      --accent-gradient: linear-gradient(135deg, #ff6b35, #ff8c61);
      --btn-secondary-bg: #22223a;
      --btn-secondary-hover: #30304e;
      --btn-disabled-bg: #3a3a4e;
      --btn-disabled-text: #8080a0;
      --status-text: #8a8aaa;
      --status-inactive: #505068;
      --error-bg: #2d1216;
      --error-border: #5c2028;
      --error-text: #ff6b6b;
      --delete-bg: #2d1216;
      --delete-text: #ff6b6b;
      --scrollbar: #353550;
      --shadow: rgba(0, 0, 0, 0.4);
      --count-bg: #1e1e34;
      --count-text: #7878a0;
      --empty-text: #686888;
    }

    :host([data-theme='light']) {
      --bg-base: #f2f0ed;
      --bg-surface: #ffffff;
      --bg-surface-hover: #f8f7f6;
      --bg-elevated: #ffffff;
      --bg-elevated-hover: #f5f4f2;
      --bg-input: #f8f7f5;
      --bg-header: linear-gradient(135deg, #ffffff 0%, #f5f3f0 100%);
      --bg-column-header: linear-gradient(180deg, #fafaf8 0%, #ffffff 100%);
      --border-default: #e0ddd8;
      --border-subtle: #e8e5e0;
      --border-hover: #d0ccc5;
      --border-input: #d8d4ce;
      --text-primary: #1a1a1a;
      --text-secondary: #5a5a68;
      --text-muted: #8a8a98;
      --text-dimmed: #aaa8b0;
      --text-placeholder: #b0aeb8;
      --accent: #e85a2a;
      --accent-hover: #d04e20;
      --accent-glow: rgba(232, 90, 42, 0.25);
      --accent-bg: rgba(232, 90, 42, 0.06);
      --accent-gradient: linear-gradient(135deg, #e85a2a, #ff7a48);
      --btn-secondary-bg: #eae8e4;
      --btn-secondary-hover: #dddad5;
      --btn-disabled-bg: #d8d5d0;
      --btn-disabled-text: #a0a0a8;
      --status-text: #8a8a98;
      --status-inactive: #c8c5c0;
      --error-bg: #fce8e8;
      --error-border: #f0b8b8;
      --error-text: #c0392b;
      --delete-bg: #fce8e8;
      --delete-text: #c0392b;
      --scrollbar: #d0ccc5;
      --shadow: rgba(0, 0, 0, 0.08);
      --count-bg: #f0eeea;
      --count-text: #8a8a98;
      --empty-text: #b0aeb8;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 16px;
      background: var(--bg-header);
      border-bottom: 1px solid var(--border-input);
      flex-shrink: 0;
      transition:
        background 0.3s ease,
        border-color 0.3s ease;
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .logo-icon {
      font-size: 18px;
      filter: drop-shadow(0 0 8px var(--accent-glow));
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status-inactive);
      transition: background 0.3s ease;
    }

    .status-dot.connected {
      background: #00e676;
      box-shadow: 0 0 8px rgba(0, 230, 118, 0.5);
    }

    .status-dot.reconnecting {
      background: #ef4444;
      box-shadow: 0 0 8px rgba(239, 68, 68, 0.5);
      animation: pulse 1.5s ease-in-out infinite;
    }

    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.3;
      }
    }

    h1 {
      font-family: 'Space Mono', monospace;
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 3px;
      text-transform: uppercase;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header-controls {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .theme-toggle {
      background: none;
      border: 1px solid var(--border-input);
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0;
      width: 30px;
      height: 30px;
      border-radius: 6px;
      font-size: 16px;
      line-height: 1;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .theme-toggle:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-bg);
    }

    .error-bar {
      background: var(--error-bg);
      border-bottom: 1px solid var(--error-border);
      padding: 8px 28px;
      font-size: 13px;
      color: var(--error-text);
      font-family: 'Space Mono', monospace;
      transition:
        background 0.3s ease,
        border-color 0.3s ease;
    }

    main {
      flex: 1;
      overflow: hidden;
      display: flex;
    }

    .board-area {
      flex: 1;
      overflow: hidden;
    }

    /*
     * Native <dialog> + showModal() is used deliberately: the browser provides
     * the top layer, inert background, focus trap, Esc handling and focus
     * restoration. Only backdrop dismissal and scroll locking are ours.
     * Sizes follow Carbon's large modal guidance (up to 96% of the viewport),
     * then cap at a comfortable reading width on 4K displays.
     */
    .task-detail {
      width: min(1680px, calc(100vw - 48px));
      height: min(88dvh, 1100px);
      max-height: calc(100dvh - 24px);
      margin: auto;
      padding: 0;
      border: 1px solid var(--border-default);
      border-radius: 14px;
      background: var(--bg-surface);
      color: var(--text-primary);
      box-shadow: 0 24px 80px var(--shadow);
      overflow: hidden;
      transition:
        background 0.3s ease,
        border-color 0.3s ease;
    }

    .task-detail[open] {
      display: flex;
      flex-direction: column;
      animation: dialogIn 0.18s ease-out;
    }

    .task-detail::backdrop {
      background: rgba(4, 4, 10, 0.62);
    }

    @keyframes dialogIn {
      from {
        opacity: 0;
        transform: translateY(8px) scale(0.99);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .task-detail[open] {
        animation: none;
      }
    }

    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border-subtle);
      flex-shrink: 0;
    }

    .detail-header-title {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .detail-close {
      background: none;
      border: 1px solid var(--border-input);
      color: var(--text-secondary);
      cursor: pointer;
      width: 30px;
      height: 30px;
      border-radius: 6px;
      font-size: 14px;
      line-height: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }

    .detail-close:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-bg);
    }

    .detail-close:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .detail-scroll {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 28px 32px 32px;
    }

    .detail-scroll::-webkit-scrollbar {
      width: 6px;
    }

    .detail-scroll::-webkit-scrollbar-track {
      background: transparent;
    }

    .detail-scroll::-webkit-scrollbar-thumb {
      background: var(--scrollbar);
      border-radius: 3px;
    }

    .detail-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: clamp(24px, 3vw, 48px);
      align-items: start;
      min-height: 100%;
    }

    .detail-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .detail-badges {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .detail-badge {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }

    .detail-badge.priority-P0 {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }

    .detail-badge.priority-P1 {
      background: rgba(245, 158, 11, 0.15);
      color: #f59e0b;
    }

    .detail-badge.priority-P2 {
      background: rgba(107, 114, 128, 0.15);
      color: #6b7280;
    }

    .detail-badge.column {
      background: var(--count-bg);
      color: var(--text-secondary);
    }

    .detail-task-title {
      font-size: clamp(22px, 1.6vw, 30px);
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.3;
      margin: 0;
      word-break: break-word;
    }

    .detail-section-label {
      font-family: 'Space Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--text-dimmed);
      margin: 0 0 8px;
    }

    .detail-description {
      max-width: 90ch;
      font-size: 15px;
      color: var(--text-secondary);
      line-height: 1.75;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .detail-description.is-empty {
      color: var(--text-dimmed);
      font-style: italic;
    }

    .detail-sidebar {
      min-width: 0;
      align-self: stretch;
      border-left: 1px solid var(--border-subtle);
      padding-left: clamp(20px, 2vw, 32px);
    }

    .detail-meta {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr);
      gap: 10px 12px;
      margin: 0;
      font-size: 13px;
    }

    .detail-meta dt {
      font-family: 'Space Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-dimmed);
      padding-top: 2px;
    }

    .detail-meta dd {
      margin: 0;
      color: var(--text-secondary);
      word-break: break-word;
    }

    @media (max-width: 900px) {
      .detail-layout {
        grid-template-columns: minmax(0, 1fr);
        gap: 24px;
      }

      .detail-sidebar {
        border-left: none;
        border-top: 1px solid var(--border-subtle);
        padding-left: 0;
        padding-top: 20px;
      }
    }

    @media (max-width: 600px) {
      header {
        padding: 4px 10px;
      }

      h1 {
        font-size: 12px;
        letter-spacing: 1px;
      }

      .logo {
        gap: 6px;
      }

      .logo-icon {
        font-size: 14px;
      }

      .header-controls {
        gap: 8px;
      }

      .theme-toggle {
        padding: 4px 6px;
        font-size: 14px;
      }

      .status-dot {
        width: 6px;
        height: 6px;
      }

      .error-bar {
        padding: 6px 10px;
        font-size: 11px;
      }

      main {
        overflow: auto;
      }

      .task-detail {
        width: calc(100vw - 16px);
        height: auto;
        min-height: 0;
        max-height: 92dvh;
        border-radius: 12px;
      }

      .detail-header {
        padding: 10px 14px;
      }

      .detail-scroll {
        padding: 20px 16px 24px;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.initTheme();
    void this.loadBoard();
    this.connectSSE();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.closeSSE();
    this.unlockBodyScroll();
  }

  updated() {
    this.syncDetailDialog();
  }

  private closeSSE() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.eventSource?.close();
    this.eventSource = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectSSE();
    }, this.reconnectDelay);

    // Exponential backoff capped at MAX_RECONNECT_DELAY
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      KanbrawlApp.MAX_RECONNECT_DELAY,
    );
  }

  private initTheme() {
    const stored = localStorage.getItem('kanbrawl-theme') as Theme | undefined;
    this.theme = stored ?? this.getDefaultTheme();
    this.applyTheme();
  }

  private getDefaultTheme(): Theme {
    // Config from kanbrawl.json takes precedence over system preference
    if (this.board.theme) return this.board.theme;
    return globalThis.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
  }

  private toggleTheme() {
    this.theme = this.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('kanbrawl-theme', this.theme);
    this.applyTheme();
  }

  private applyTheme() {
    this.dataset.theme = this.theme;
    document.body.style.background =
      this.theme === 'light' ? '#f2f0ed' : '#0a0a0f';
    document.body.style.color = this.theme === 'light' ? '#1a1a1a' : '#ebebeb';
  }

  private async loadBoard() {
    try {
      this.board = await fetchBoard();
      this.error = null;
      // Re-evaluate theme now that we have the server config
      if (!localStorage.getItem('kanbrawl-theme') && this.board.theme) {
        this.theme = this.board.theme;
        this.applyTheme();
      }
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : 'Failed to load board';
    }
  }

  private connectSSE() {
    this.closeSSE();
    this.eventSource = new EventSource('/events');

    this.eventSource.addEventListener('board_sync', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      this.board = { ...data.board };
      this.connected = true;
      this.error = null;
      this.reconnectDelay = KanbrawlApp.BASE_RECONNECT_DELAY;
    });

    this.eventSource.addEventListener('task_created', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      this.board = {
        ...this.board,
        tasks: [...this.board.tasks, data.task],
      };
    });

    this.eventSource.addEventListener('task_updated', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      this.board = {
        ...this.board,
        tasks: this.board.tasks.map((t) =>
          t.id === data.task.id ? data.task : t,
        ),
      };
    });

    this.eventSource.addEventListener('task_moved', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      this.board = {
        ...this.board,
        tasks: this.board.tasks.map((t) =>
          t.id === data.task.id ? data.task : t,
        ),
      };
    });

    this.eventSource.addEventListener('task_deleted', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      if (this.selectedTaskId === data.taskId) {
        this.selectedTaskId = undefined;
      }

      this.board = {
        ...this.board,
        tasks: this.board.tasks.filter((t) => t.id !== data.taskId),
      };
    });

    this.eventSource.addEventListener('columns_updated', (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      this.board = {
        ...this.board,
        columns: data.columns,
      };
    });

    this.eventSource.addEventListener('open', () => {
      this.connected = true;
      this.error = null;
      this.reconnectDelay = KanbrawlApp.BASE_RECONNECT_DELAY;
      // Re-fetch board to catch any events missed during disconnect
      void this.loadBoard();
    });

    this.eventSource.addEventListener('error', () => {
      this.connected = false;
      // Close and manually reconnect to ensure clean state
      this.eventSource?.close();
      this.eventSource = null;
      this.scheduleReconnect();
    });
  }

  private async handleCreateTask(
    e: CustomEvent<{
      title: string;
      description: string;
      column: string;
      priority?: string;
      assignee?: string;
    }>,
  ) {
    try {
      await createTask(
        e.detail.title,
        e.detail.description,
        e.detail.column,
        e.detail.priority,
        e.detail.assignee,
      );
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : 'Failed to create task';
    }
  }

  private async handleUpdateTask(
    e: CustomEvent<{
      id: string;
      title?: string;
      description?: string;
      column?: string;
      priority?: string;
      assignee?: string;
    }>,
  ) {
    try {
      const { id, ...fields } = e.detail;
      await updateTask(id, fields);
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : 'Failed to update task';
    }
  }

  private async handleDeleteTask(e: CustomEvent<{ id: string }>) {
    try {
      await deleteTask(e.detail.id);
      // Close the dialog if the deleted task was being viewed
      if (this.selectedTaskId === e.detail.id) {
        this.selectedTaskId = undefined;
      }
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : 'Failed to delete task';
    }
  }

  private handleViewTask(e: CustomEvent<{ task: Task }>) {
    this.selectedTaskId = e.detail.task.id;
  }

  private get currentTask(): Task | undefined {
    if (!this.selectedTaskId) return undefined;
    return this.board.tasks.find((task) => task.id === this.selectedTaskId);
  }

  private get detailDialog(): HTMLDialogElement | undefined {
    return (
      this.renderRoot.querySelector<HTMLDialogElement>('dialog.task-detail') ??
      undefined
    );
  }

  private syncDetailDialog() {
    const dialog = this.detailDialog;
    if (!dialog) return;

    if (this.currentTask) {
      if (!dialog.open) {
        this.lockBodyScroll();
        dialog.showModal();
        dialog.querySelector<HTMLElement>('.detail-close')?.focus();
      }

      return;
    }

    if (dialog.open) dialog.close();
  }

  private lockBodyScroll() {
    if (this.previousBodyOverflow !== undefined) return;
    this.previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }

  private unlockBodyScroll() {
    if (this.previousBodyOverflow === undefined) return;
    document.body.style.overflow = this.previousBodyOverflow;
    this.previousBodyOverflow = undefined;
  }

  private handleDetailClose() {
    this.unlockBodyScroll();
    this.selectedTaskId = undefined;
  }

  private handleDetailBackdrop(e: MouseEvent) {
    const dialog = e.currentTarget as HTMLDialogElement;
    if (e.target !== dialog) return;

    // Padding clicks also target the dialog; only a point outside its box
    // counts as a backdrop click.
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) this.closeDetailPanel();
  }

  private closeDetailPanel() {
    const dialog = this.detailDialog;
    if (dialog?.open) {
      dialog.close();
    } else {
      this.handleDetailClose();
    }
  }

  private formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  private renderDetailDialog() {
    const task = this.currentTask;
    return html`
      <dialog
        class="task-detail"
        aria-labelledby="detail-title"
        @click=${this.handleDetailBackdrop}
        @close=${this.handleDetailClose}
      >
        ${task
          ? html`
              <div class="detail-header">
                <span class="detail-header-title">Task Detail</span>
                <button
                  class="detail-close"
                  title="Close"
                  aria-label="Close task details"
                  @click=${this.closeDetailPanel}
                >
                  ✕
                </button>
              </div>
              <div class="detail-scroll">
                <div class="detail-layout">
                  <div class="detail-main">
                    <div class="detail-badges">
                      <span class="detail-badge priority-${task.priority}"
                        >${task.priority}</span
                      >
                      <span class="detail-badge column">${task.column}</span>
                    </div>
                    <h2 class="detail-task-title" id="detail-title">
                      ${task.title}
                    </h2>
                    <section aria-labelledby="detail-description-label">
                      <h3
                        class="detail-section-label"
                        id="detail-description-label"
                      >
                        Description
                      </h3>
                      <div
                        class=${task.description
                          ? 'detail-description'
                          : 'detail-description is-empty'}
                      >
                        ${task.description || 'No description.'}
                      </div>
                    </section>
                  </div>
                  <aside class="detail-sidebar" aria-label="Task metadata">
                    <h3 class="detail-section-label">Details</h3>
                    <dl class="detail-meta">
                      <dt>Assignee</dt>
                      <dd>${task.assignee || '—'}</dd>
                      <dt>Column</dt>
                      <dd>${task.column}</dd>
                      <dt>Created</dt>
                      <dd>${this.formatTimestamp(task.createdAt)}</dd>
                      <dt>Updated</dt>
                      <dd>${this.formatTimestamp(task.updatedAt)}</dd>
                    </dl>
                  </aside>
                </div>
              </div>
            `
          : null}
      </dialog>
    `;
  }

  private async handleUpdateColumns(e: CustomEvent<{ columns: Column[] }>) {
    try {
      await updateColumns(e.detail.columns);
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : 'Failed to update columns';
    }
  }

  render() {
    return html`
      <header>
        <div class="logo">
          <span class="logo-icon">🥊</span>
          <h1>Kanbrawl</h1>
          <div
            class="status-dot ${this.connected ? 'connected' : 'reconnecting'}"
            title=${this.connected ? 'Connected' : 'Reconnecting...'}
          ></div>
        </div>
        <div class="header-controls">
          <kanbrawl-column-settings
            .columns=${this.board.columns}
            @update-columns=${this.handleUpdateColumns}
          ></kanbrawl-column-settings>
          <button
            class="theme-toggle"
            title="Toggle theme"
            @click=${this.toggleTheme}
          >
            ${this.theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>
      ${this.error ? html`<div class="error-bar">⚠ ${this.error}</div>` : null}
      <main>
        <div class="board-area">
          <kanbrawl-board
            .columns=${this.board.columns}
            .tasks=${this.board.tasks}
            @create-task=${this.handleCreateTask}
            @update-task=${this.handleUpdateTask}
            @delete-task=${this.handleDeleteTask}
            @view-task=${this.handleViewTask}
          ></kanbrawl-board>
        </div>
      </main>
      ${this.renderDetailDialog()}
    `;
  }
}
