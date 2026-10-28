import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Task } from '../../../shared/board.js';
import { attachmentUrl } from '../api.js';
import './app-button.js';
import './app-badge.js';

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

    .task-open::part(button):focus-visible {
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
      flex-shrink: 0;
      margin-top: 1px;
    }

    .stale-badge {
      margin-left: auto;
      flex-shrink: 0;
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

    .task-images {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 8px;
    }

    .task-image-thumb {
      width: 36px;
      height: 36px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--border-subtle);
    }

    .task-image-count {
      font-family: 'Space Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: var(--text-muted);
      background: var(--count-bg);
      border-radius: 8px;
      padding: 2px 6px;
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

    .action-btn::part(button) {
      border: none;
      border-radius: 5px;
      color: var(--text-muted);
      font-size: 14px;
    }

    .action-btn::part(button):hover:enabled {
      background: var(--border-subtle);
      color: var(--text-primary);
    }

    .action-btn.delete::part(button) {
      color: var(--text-muted);
    }

    .action-btn.delete::part(button):hover:enabled {
      background: var(--delete-bg);
      color: var(--delete-text);
    }

    @media (pointer: coarse) {
      .task-actions {
        opacity: 1;
      }

      .action-btn::part(button) {
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
        <kanbrawl-button
          variant="plain"
          block
          class="task-open"
          aria-label="Open task: ${this.task.title}"
          @click=${this.handleViewTask}
        >
          <span class="task-header">
            <kanbrawl-badge
              class="priority-badge priority-${this.task.priority}"
              tone=${this.task.priority}
              size="sm"
              >${this.task.priority}</kanbrawl-badge
            >
            <span class="task-title">${this.task.title}</span>
            ${this.stale
              ? html`<kanbrawl-badge
                  class="stale-badge"
                  tone="stale"
                  size="sm"
                  title="Last updated ${this.formatFullTimestamp(
                    this.task.updatedAt,
                  )}"
                  >stale</kanbrawl-badge
                >`
              : nothing}
          </span>
          ${this.task.description
            ? html`<span class="task-description"
                >${this.task.description}</span
              >`
            : nothing}
          ${this.task.attachments.length > 0
            ? html`<span class="task-images">
                ${this.task.attachments
                  .slice(0, 3)
                  .map(
                    (meta) =>
                      html`<img
                        class="task-image-thumb"
                        src=${attachmentUrl(meta.id)}
                        alt=""
                        loading="lazy"
                        title=${meta.filename}
                      />`,
                  )}
                <span
                  class="task-image-count"
                  title="${this.task.attachments.length} image(s)"
                >
                  📎 ${this.task.attachments.length}
                </span>
              </span>`
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
        </kanbrawl-button>
        <div class="task-actions">
          <kanbrawl-button
            class="action-btn"
            variant="ghost"
            icon
            size="sm"
            title="Edit"
            aria-label="Edit ${this.task.title}"
            @click=${this.requestEdit}
          >
            ✎
          </kanbrawl-button>
          <kanbrawl-button
            class="action-btn delete"
            variant="danger-outline"
            icon
            size="sm"
            title="Delete"
            aria-label="Delete ${this.task.title}"
            @click=${this.requestDelete}
          >
            ✕
          </kanbrawl-button>
        </div>
      </div>
    `;
  }
}
