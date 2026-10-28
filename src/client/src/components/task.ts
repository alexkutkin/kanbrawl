import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Task } from '../types.js';

@customElement('kanbrawl-task')
export class KanbrawlTask extends LitElement {
  @property({ type: Object }) task!: Task;
  @property({ type: Array }) allColumns: string[] = [];
  @property({ type: Boolean }) stale = false;

  static styles = css`
    :host {
      display: block;
      animation: slideIn 0.25s ease-out;
    }

    :host(.dragging) {
      opacity: 0.4;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-8px) scale(0.97);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .task-card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px 12px 10px;
      transition:
        border-color 0.2s ease,
        background 0.2s ease;
      position: relative;
    }

    .task-card:hover {
      border-color: var(--border-hover);
      background: var(--bg-elevated-hover);
    }

    .task-open {
      display: block;
      width: 100%;
      padding: 0;
      border: none;
      background: none;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }

    .task-open:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 4px;
      border-radius: 4px;
    }

    .task-header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 4px;
    }

    .priority-badge {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      letter-spacing: 0.5px;
      flex-shrink: 0;
      margin-top: 1px;
    }

    .priority-P0 {
      background: var(--priority-p0-bg, rgba(239, 68, 68, 0.15));
      color: var(--priority-p0-text, #ff8585);
    }

    .priority-P1 {
      background: var(--priority-p1-bg, rgba(245, 158, 11, 0.15));
      color: var(--priority-p1-text, #fbbf24);
    }

    .priority-P2 {
      background: var(--priority-p2-bg, rgba(107, 114, 128, 0.18));
      color: var(--priority-p2-text, #a9b0bd);
    }

    .stale-badge {
      margin-left: auto;
      flex-shrink: 0;
      font-family: 'Space Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      color: var(--stale-text);
      background: var(--stale-bg);
      border-radius: 4px;
      padding: 2px 6px;
    }

    .task-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.4;
      word-break: break-word;
      flex: 1;
    }

    .task-description {
      font-size: 12px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 8px;
      word-break: break-word;
      white-space: pre-wrap;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .task-meta-left {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding-right: 64px;
    }

    .task-time {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--text-dimmed);
      letter-spacing: 0.3px;
      flex-shrink: 0;
    }

    .task-assignee {
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--count-bg);
      padding: 2px 8px;
      border-radius: 10px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 140px;
    }

    .task-actions {
      position: absolute;
      right: 8px;
      bottom: 8px;
      display: flex;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.15s ease;
    }

    .task-card:hover .task-actions,
    .task-card:focus-within .task-actions {
      opacity: 1;
    }

    .action-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      min-width: 28px;
      min-height: 28px;
      border-radius: 5px;
      font-size: 14px;
      line-height: 1;
      transition:
        background 0.15s ease,
        color 0.15s ease;
    }

    .action-btn:hover {
      background: var(--border-subtle);
      color: var(--text-primary);
    }

    .action-btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }

    .action-btn.delete:hover {
      background: var(--delete-bg);
      color: var(--delete-text);
    }

    @media (pointer: coarse) {
      .task-actions {
        opacity: 1;
      }

      .action-btn {
        min-width: 36px;
        min-height: 36px;
        font-size: 16px;
      }
    }

    @media (max-width: 600px) {
      .task-card {
        padding: 12px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host {
        animation: none;
      }

      .task-actions {
        transition: none;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.draggable = true;
    this.addEventListener('dragstart', this._onDragStart);
    this.addEventListener('dragend', this._onDragEnd);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('dragstart', this._onDragStart);
    this.removeEventListener('dragend', this._onDragEnd);
  }

  private readonly _onDragStart = (e: DragEvent) => {
    e.dataTransfer?.setData('text/plain', this.task.id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => {
      this.classList.add('dragging');
    });
  };

  private readonly _onDragEnd = () => {
    this.classList.remove('dragging');
  };

  private formatTime(iso: string): string {
    const date = new Date(iso);
    const diff = Date.now() - date.getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  private formatFullTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  private requestEdit() {
    this.dispatchEvent(
      new CustomEvent('edit-task', {
        detail: { task: this.task },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private requestDelete() {
    this.dispatchEvent(
      new CustomEvent('delete-task', {
        detail: { id: this.task.id, title: this.task.title },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private handleViewTask() {
    this.dispatchEvent(
      new CustomEvent('view-task', {
        detail: { task: this.task },
        bubbles: true,
        composed: true,
      }),
    );
  }

  render() {
    return html`
      <div class="task-card">
        <button
          type="button"
          class="task-open"
          aria-label="Open task: ${this.task.title}"
          @click=${this.handleViewTask}
        >
          <span class="task-header">
            <span class="priority-badge priority-${this.task.priority}"
              >${this.task.priority}</span
            >
            <span class="task-title">${this.task.title}</span>
            ${this.stale
              ? html`<span
                  class="stale-badge"
                  title="Last updated ${this.formatFullTimestamp(
                    this.task.updatedAt,
                  )}"
                  >stale</span
                >`
              : nothing}
          </span>
          ${this.task.description
            ? html`<span class="task-description"
                >${this.task.description}</span
              >`
            : nothing}
          <span class="task-meta-left">
            <span
              class="task-time"
              title=${this.formatFullTimestamp(this.task.updatedAt)}
              >${this.formatTime(this.task.updatedAt)}</span
            >
            ${this.task.assignee
              ? html`<span class="task-assignee" title=${this.task.assignee}
                  >${this.task.assignee}</span
                >`
              : nothing}
          </span>
        </button>
        <div class="task-actions">
          <button
            class="action-btn"
            title="Edit"
            aria-label="Edit ${this.task.title}"
            @click=${this.requestEdit}
          >
            ✎
          </button>
          <button
            class="action-btn delete"
            title="Delete"
            aria-label="Delete ${this.task.title}"
            @click=${this.requestDelete}
          >
            ✕
          </button>
        </div>
      </div>
    `;
  }
}
