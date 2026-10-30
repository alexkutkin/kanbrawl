import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { Task, Column, Project } from '../../../shared/board.js';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

@customElement('kanbrawl-board')
export class KanbrawlBoard extends LitElement {
  @property({ type: Array }) columns: Column[] = [];
  @property({ type: Array }) tasks: Task[] = [];
  @property({ type: Array }) projects: Project[] = [];

  // Touch drag state (non-reactive, internal coordination only)
  private _touchDragId: string | undefined;
  private _touchTargetColumn: string | undefined;
  private _touchTimer: ReturnType<typeof setTimeout> | undefined;
  private _touchGhost: HTMLElement | undefined;
  private _touchStartX = 0;
  private _touchStartY = 0;

  static styles = css`
    :host {
      display: block;
      height: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      padding: 12px;
      box-sizing: border-box;
    }

    .board {
      display: flex;
      gap: 12px;
      height: 100%;
      min-width: min-content;
      justify-content: center;
    }

    kanbrawl-column {
      flex: 1 1 380px;
      min-width: 300px;
      max-width: 480px;
      height: 100%;
    }

    kanbrawl-column.folded {
      flex: 0 0 44px;
      min-width: 44px;
      max-width: 44px;
    }

    .touch-ghost {
      position: fixed;
      z-index: 9999;
      padding: 10px 16px;
      background: var(--accent);
      color: var(--on-accent);
      border-radius: 8px;
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      font-weight: 600;
      pointer-events: none;
      opacity: 0.92;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      box-shadow: 0 4px 20px var(--shadow);
      transform: scale(1.05);
    }

    @media (max-width: 768px) {
      kanbrawl-column {
        min-width: 260px;
      }
    }

    @media (max-width: 600px) {
      :host {
        height: auto;
        overflow-x: hidden;
        overflow-y: visible;
      }

      .board {
        flex-direction: column;
        min-width: 0;
        height: auto;
        gap: 12px;
      }

      kanbrawl-column {
        min-width: 0;
        max-width: none;
      }

      kanbrawl-column.folded {
        flex: 1 0 0%;
        min-width: 0;
        max-width: none;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .touch-ghost {
        transform: none;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('touchstart', this._onTouchStart, { passive: true });
    this.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.addEventListener('touchend', this._onTouchEnd);
    this.addEventListener('touchcancel', this._onTouchEnd);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('touchstart', this._onTouchStart);
    this.removeEventListener('touchmove', this._onTouchMove);
    this.removeEventListener('touchend', this._onTouchEnd);
    this.removeEventListener('touchcancel', this._onTouchEnd);
    this._cleanupTouchDrag();
  }

  private readonly _onTouchStart = (e: TouchEvent) => {
    const path = e.composedPath();

    // Don't initiate drag on form controls or action buttons. The card body
    // itself is a button (it opens the detail dialog), so it stays draggable.
    if (
      path.some(
        (element) =>
          element instanceof HTMLElement &&
          (element.tagName === 'INPUT' ||
            element.tagName === 'TEXTAREA' ||
            element.tagName === 'SELECT' ||
            element.classList.contains('action-btn') ||
            element.classList.contains('add-btn') ||
            element.classList.contains('fold-btn')),
      )
    ) {
      return;
    }

    const taskElement = path.find(
      (element) =>
        element instanceof HTMLElement && element.tagName === 'KANBRAWL-TASK',
    ) as HTMLElement | undefined;
    if (!taskElement) return;

    const touch = e.touches[0];
    this._touchStartX = touch.clientX;
    this._touchStartY = touch.clientY;

    this._touchTimer = globalThis.setTimeout(() => {
      const taskId = (taskElement as { task?: Task }).task?.id;
      if (!taskId) return;
      this._startTouchDrag(taskId, touch.clientX, touch.clientY);
    }, 300);
  };

  private _startTouchDrag(taskId: string, x: number, y: number) {
    this._touchDragId = taskId;

    const ghost = document.createElement('div');
    ghost.className = 'touch-ghost';
    const task = this.tasks.find((t) => t.id === taskId);
    ghost.textContent = task?.title ?? '';
    ghost.style.left = `${x - 40}px`;
    ghost.style.top = `${y - 20}px`;
    this.shadowRoot!.append(ghost);
    this._touchGhost = ghost;

    navigator.vibrate?.(50);
  }

  private readonly _onTouchMove = (e: TouchEvent) => {
    // Cancel long-press if finger moved before timer fired
    if (this._touchTimer !== undefined && !this._touchDragId) {
      const touch = e.touches[0];
      const dx = Math.abs(touch.clientX - this._touchStartX);
      const dy = Math.abs(touch.clientY - this._touchStartY);
      if (dx > 10 || dy > 10) {
        clearTimeout(this._touchTimer);
        this._touchTimer = undefined;
      }

      return;
    }

    if (!this._touchDragId) return;
    e.preventDefault(); // Prevent scroll while dragging

    const touch = e.touches[0];

    if (this._touchGhost) {
      this._touchGhost.style.left = `${touch.clientX - 40}px`;
      this._touchGhost.style.top = `${touch.clientY - 20}px`;
    }

    const columns = this.shadowRoot!.querySelectorAll('kanbrawl-column');
    let foundColumn: string | undefined;
    for (const column of columns) {
      const rect = column.getBoundingClientRect();
      if (
        touch.clientX >= rect.left &&
        touch.clientX <= rect.right &&
        touch.clientY >= rect.top &&
        touch.clientY <= rect.bottom
      ) {
        foundColumn = (column as { name?: string }).name;
        break;
      }
    }

    if (foundColumn !== this._touchTargetColumn) {
      for (const column of columns) {
        if ((column as { name?: string }).name === foundColumn) {
          column.classList.add('drag-over');
        } else {
          column.classList.remove('drag-over');
        }
      }

      this._touchTargetColumn = foundColumn;
    }
  };

  private readonly _onTouchEnd = () => {
    if (this._touchTimer !== undefined) {
      clearTimeout(this._touchTimer);
      this._touchTimer = undefined;
    }

    if (this._touchDragId && this._touchTargetColumn) {
      const task = this.tasks.find((t) => t.id === this._touchDragId);
      if (task && task.column !== this._touchTargetColumn) {
        this.dispatchEvent(
          new CustomEvent('update-task', {
            detail: { id: this._touchDragId, column: this._touchTargetColumn },
            bubbles: true,
            composed: true,
          }),
        );
      }
    }

    this._cleanupTouchDrag();
  };

  private _cleanupTouchDrag() {
    if (this._touchTimer !== undefined) {
      clearTimeout(this._touchTimer);
      this._touchTimer = undefined;
    }

    if (this._touchGhost) {
      this._touchGhost.remove();
      this._touchGhost = undefined;
    }

    for (const column of this.shadowRoot?.querySelectorAll('kanbrawl-column') ??
      [])
      column.classList.remove('drag-over');
    this._touchDragId = undefined;
    this._touchTargetColumn = undefined;
  }

  private isStale(task: Task): boolean {
    const index = this.columns.findIndex(
      (column) => column.name === task.column,
    );
    if (index <= 0 || index >= this.columns.length - 1) return false;
    const updated = new Date(task.updatedAt).getTime();
    return Number.isFinite(updated) && Date.now() - updated > STALE_AFTER_MS;
  }

  render() {
    const columnNames = this.columns.map((c) => c.name);
    const staleIds = new Set(
      this.tasks.filter((task) => this.isStale(task)).map((task) => task.id),
    );

    return html`
      <div class="board">
        ${this.columns.map(
          (column) => html`
            <kanbrawl-column
              .name=${column.name}
              .tasks=${this.tasks.filter((t) => t.column === column.name)}
              .projects=${this.projects}
              .allColumns=${columnNames}
              .sortBy=${column.sortBy}
              .sortOrder=${column.sortOrder}
              .staleIds=${staleIds}
            ></kanbrawl-column>
          `,
        )}
      </div>
    `;
  }
}
