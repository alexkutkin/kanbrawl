import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  LIMITS,
  type Board,
  type Priority,
  type Task,
  type Column,
} from '../../shared/board.js';
import {
  fetchBoard,
  createTask,
  updateTask,
  deleteTask,
  updateColumns,
  ApiError,
} from './api.js';
import {
  BoardSession,
  type BoardSnapshots,
  type ConnectionStatus,
} from './board-session.js';
import { EventSourceTransport } from './event-source-transport.js';
import {
  transition,
  type TaskDialogAction,
  type TaskDialogState,
  type TaskFields,
} from './task-dialog.js';
import './components/column-settings.js';

type Theme = 'light' | 'dark';

type ResultCallbacks = {
  resolve?: () => void;
  reject?: (message: string) => void;
};

type UpdateTaskDetail = {
  id: string;
  title?: string;
  description?: string;
  column?: string;
  priority?: string;
  assignee?: string;
} & ResultCallbacks;

type DeleteTaskDetail = { id: string; title: string };

type UpdateColumnsDetail = {
  columns: Column[];
  moveTo?: string;
} & ResultCallbacks;

type ErrorState = { message: string; retry?: () => void };

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const OFFLINE_BANNER_AFTER_MS = 8000;

const apiCommands = {
  fetchBoard,
  createTask,
  updateTask,
  deleteTask,
  updateColumns,
};

type MarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const INLINE_PATTERN =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+]\((?:https?:\/\/|mailto:)[^)\s]+\))/g;

// Renders a deliberately small Markdown subset as Lit templates. Everything
// the agent writes is interpolated as text, so raw HTML never becomes markup.
function renderInline(text: string): Array<string | TemplateResult> {
  const parts: Array<string | TemplateResult> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));

    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(html`<code>${token.slice(1, -1)}</code>`);
    } else if (token.startsWith('**')) {
      parts.push(html`<strong>${token.slice(2, -2)}</strong>`);
    } else if (token.startsWith('*')) {
      parts.push(html`<em>${token.slice(1, -1)}</em>`);
    } else {
      const link = /^\[([^\]]+)]\(([^)]+)\)$/.exec(token);
      if (link) {
        parts.push(
          html`<a href=${link[2]} target="_blank" rel="noopener noreferrer"
            >${link[1]}</a
          >`,
        );
      } else {
        parts.push(token);
      }
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replaceAll(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list) {
      blocks.push({ kind: 'list', ...list });
      list = undefined;
    }
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line.trimStart().startsWith('```')) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      index++;
      while (
        index < lines.length &&
        !lines[index].trimStart().startsWith('```')
      ) {
        code.push(lines[index]);
        index++;
      }

      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        kind: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        text: heading[2],
      });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }

      list.items.push(bullet[1]);
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list?.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }

      list.items.push(ordered[1]);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderBlock(block: MarkdownBlock): TemplateResult {
  switch (block.kind) {
    case 'code': {
      return html`<pre><code>${block.text}</code></pre>`;
    }

    case 'heading': {
      const content = renderInline(block.text);
      if (block.level === 1) return html`<h4>${content}</h4>`;
      if (block.level === 2) return html`<h5>${content}</h5>`;
      return html`<h6>${content}</h6>`;
    }

    case 'list': {
      const items = block.items.map(
        (item) => html`<li>${renderInline(item)}</li>`,
      );
      return block.ordered
        ? html`<ol>
            ${items}
          </ol>`
        : html`<ul>
            ${items}
          </ul>`;
    }

    case 'paragraph': {
      return html`<p>${renderInline(block.text)}</p>`;
    }
  }

  return html``;
}

function renderMarkdown(source: string): TemplateResult[] {
  return parseMarkdown(source).map((block) => renderBlock(block));
}

@customElement('kanbrawl-app')
export class KanbrawlApp extends LitElement {
  @state() private session: BoardSnapshots = {
    board: { columns: [], tasks: [] },
    connection: 'connecting',
  };

  @state() private clock = Date.now();
  @state() private error: ErrorState | undefined;
  @state() private theme: Theme = 'dark';
  @state() private notice: string | undefined;
  @state() private dialog: TaskDialogState = { mode: 'closed' };
  @state() private copiedId: string | undefined;
  @state() private pendingDelete: { id: string; title: string } | undefined;
  @state() private deletePending = false;
  @state() private deleteError: string | undefined;

  private readonly boardSession = new BoardSession(
    new EventSourceTransport(),
    apiCommands,
    {
      onError: (error) => {
        this.handleSessionError(error);
      },
    },
  );

  private unsubscribe: (() => void) | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;
  private boardLoaded = false;
  private pushedTaskEntry = false;

  private get board(): Board {
    return this.session.board;
  }

  private get connection(): ConnectionStatus {
    return this.session.connection;
  }

  private get lastSyncAt(): number | undefined {
    return this.session.lastSyncAt;
  }

  private get selectedTaskId(): string | undefined {
    const { dialog } = this;
    if (dialog.mode === 'view') return dialog.taskId;
    if (dialog.mode === 'edit') return dialog.base.id;
    return undefined;
  }

  private get detailTask(): Task | undefined {
    const id = this.selectedTaskId;
    if (!id) return undefined;
    return this.board.tasks.find((task) => task.id === id);
  }

  private get editing(): boolean {
    return this.dialog.mode === 'edit';
  }

  private get detailPending(): boolean {
    const { dialog } = this;
    return (
      (dialog.mode === 'edit' || dialog.mode === 'create') && dialog.pending
    );
  }

  private get detailError(): string | undefined {
    const { dialog } = this;
    if (dialog.mode === 'edit' || dialog.mode === 'create') return dialog.error;
    return undefined;
  }

  private dispatch(action: TaskDialogAction) {
    this.dialog = transition(this.dialog, action);
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
      --text-secondary: #b0b0cc;
      --text-muted: #9595b8;
      --text-dimmed: #8585a6;
      --text-placeholder: #8d8db0;
      --accent: #ff6b35;
      --accent-hover: #ff8c61;
      --accent-glow: rgba(255, 107, 53, 0.4);
      --accent-bg: rgba(255, 107, 53, 0.08);
      --accent-gradient: linear-gradient(135deg, #ff6b35, #ff8c61);
      --on-accent: #1b1109;
      --btn-secondary-bg: #22223a;
      --btn-secondary-hover: #30304e;
      --btn-disabled-bg: #3a3a4e;
      --btn-disabled-text: #9a9ab4;
      --status-text: #a0a0c0;
      --status-inactive: #6b6b88;
      --status-online: #34d399;
      --status-offline: #ff8585;
      --error-bg: #2d1216;
      --error-border: #5c2028;
      --error-text: #ff9a9a;
      --delete-bg: #2d1216;
      --delete-text: #ff9a9a;
      --danger-solid-bg: #c0392b;
      --danger-solid-text: #ffffff;
      --scrollbar: #353550;
      --shadow: rgba(0, 0, 0, 0.4);
      --count-bg: #1e1e34;
      --count-text: #a0a0c0;
      --empty-text: #9595b8;
      --stale-bg: rgba(245, 158, 11, 0.16);
      --stale-text: #fbbf24;
      --priority-p0-bg: rgba(239, 68, 68, 0.16);
      --priority-p0-text: #ff9a9a;
      --priority-p1-bg: rgba(245, 158, 11, 0.16);
      --priority-p1-text: #fbbf24;
      --priority-p2-bg: rgba(148, 163, 184, 0.16);
      --priority-p2-text: #c3cad8;
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
      --border-default: #ddd9d3;
      --border-subtle: #e6e2dc;
      --border-hover: #cfcac3;
      --border-input: #d7d2cb;
      --text-primary: #1a1a1a;
      --text-secondary: #4f4e58;
      --text-muted: #5f5d67;
      --text-dimmed: #6f6d78;
      --text-placeholder: #6f6d78;
      --accent: #e85a2a;
      --accent-hover: #d04e20;
      --accent-glow: rgba(232, 90, 42, 0.25);
      --accent-bg: rgba(232, 90, 42, 0.08);
      --accent-gradient: linear-gradient(135deg, #e85a2a, #ff7a48);
      --on-accent: #1b1109;
      --btn-secondary-bg: #eae8e4;
      --btn-secondary-hover: #dddad5;
      --btn-disabled-bg: #d8d5d0;
      --btn-disabled-text: #6f6d78;
      --status-text: #5f5d67;
      --status-inactive: #8b8a94;
      --status-online: #0f9d58;
      --status-offline: #b42318;
      --error-bg: #fce8e8;
      --error-border: #f0b8b8;
      --error-text: #b42318;
      --delete-bg: #fce8e8;
      --delete-text: #b42318;
      --danger-solid-bg: #b42318;
      --danger-solid-text: #ffffff;
      --scrollbar: #d0ccc5;
      --shadow: rgba(0, 0, 0, 0.08);
      --count-bg: #efede9;
      --count-text: #5f5d67;
      --empty-text: #6f6d78;
      --stale-bg: #fdf0d5;
      --stale-text: #7a4a00;
      --priority-p0-bg: #fde8e8;
      --priority-p0-text: #b42318;
      --priority-p1-bg: #fdf0d5;
      --priority-p1-text: #7a4a00;
      --priority-p2-bg: #eef0f3;
      --priority-p2-text: #4a5260;
    }

    button {
      font-family: 'DM Sans', sans-serif;
    }

    button:focus-visible,
    select:focus-visible,
    a:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
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
      gap: 10px;
    }

    .logo-icon {
      font-size: 18px;
      filter: drop-shadow(0 0 8px var(--accent-glow));
    }

    .connection {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      letter-spacing: 0.5px;
      color: var(--status-text);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status-inactive);
      transition: background 0.3s ease;
      flex-shrink: 0;
    }

    .status-dot.online {
      background: var(--status-online);
      box-shadow: 0 0 8px
        color-mix(in srgb, var(--status-online) 50%, transparent);
    }

    .status-dot.offline {
      background: var(--status-offline);
      box-shadow: 0 0 8px
        color-mix(in srgb, var(--status-offline) 50%, transparent);
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
      width: 32px;
      height: 32px;
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

    .stale-banner {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      background: var(--stale-bg);
      border-bottom: 1px solid var(--border-input);
      color: var(--stale-text);
      font-size: 12px;
      flex-shrink: 0;
    }

    .stale-banner span {
      flex: 1;
    }

    .stale-banner button,
    .error-bar button {
      min-height: 28px;
      padding: 4px 12px;
      border-radius: 5px;
      border: 1px solid currentColor;
      background: transparent;
      color: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      flex-shrink: 0;
    }

    .stale-banner button:hover,
    .error-bar button:hover {
      background: color-mix(in srgb, currentColor 12%, transparent);
    }

    .error-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      background: var(--error-bg);
      border-bottom: 1px solid var(--error-border);
      padding: 8px 16px;
      font-size: 13px;
      color: var(--error-text);
      flex-shrink: 0;
    }

    .error-bar .error-message {
      flex: 1;
      min-width: 0;
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

    .notice {
      position: fixed;
      left: 50%;
      bottom: 20px;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: calc(100vw - 32px);
      padding: 10px 14px;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      background: var(--bg-elevated);
      color: var(--text-primary);
      box-shadow: 0 8px 30px var(--shadow);
      font-size: 13px;
      z-index: 3000;
      animation: noticeIn 0.18s ease-out;
    }

    .notice button {
      border: none;
      background: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      min-width: 24px;
      min-height: 24px;
    }

    .notice button:hover {
      color: var(--text-primary);
    }

    @keyframes noticeIn {
      from {
        opacity: 0;
        transform: translate(-50%, 8px);
      }
      to {
        opacity: 1;
        transform: translate(-50%, 0);
      }
    }

    /*
     * Native <dialog> + showModal() supplies the top layer, inert background,
     * focus trap, Esc handling and focus restoration. The dialog is sized by
     * its content up to a viewport cap, as recommended for detail modals.
     */
    .task-detail {
      width: min(1200px, calc(100vw - 48px));
      height: auto;
      max-height: min(88dvh, 1100px);
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

    .detail-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 20px;
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
      width: 32px;
      height: 32px;
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
      padding: 24px 32px 28px;
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
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: clamp(24px, 3vw, 48px);
      align-items: start;
    }

    .detail-main {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .detail-badges {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .detail-badge,
    .detail-stale {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      padding: 3px 10px;
      border-radius: 4px;
      letter-spacing: 0.5px;
    }

    .detail-badge.priority-P0 {
      background: var(--priority-p0-bg);
      color: var(--priority-p0-text);
    }

    .detail-badge.priority-P1 {
      background: var(--priority-p1-bg);
      color: var(--priority-p1-text);
    }

    .detail-badge.priority-P2 {
      background: var(--priority-p2-bg);
      color: var(--priority-p2-text);
    }

    .detail-badge.column {
      background: var(--count-bg);
      color: var(--text-secondary);
    }

    .detail-stale {
      background: var(--stale-bg);
      color: var(--stale-text);
      text-transform: uppercase;
    }

    .detail-task-title {
      font-size: clamp(21px, 1.6vw, 28px);
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.3;
      margin: 0;
      word-break: break-word;
    }

    .detail-id-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .detail-id {
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--text-dimmed);
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      padding: 3px 8px;
      border-radius: 5px;
      user-select: all;
      word-break: break-all;
    }

    .copy-btn {
      min-height: 28px;
      padding: 4px 10px;
      border: 1px solid var(--border-input);
      border-radius: 5px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .copy-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: var(--accent-bg);
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
      line-height: 1.7;
      word-break: break-word;
    }

    .detail-description p {
      margin: 0 0 12px;
      white-space: pre-wrap;
    }

    .detail-description > *:last-child {
      margin-bottom: 0;
    }

    .detail-description ul,
    .detail-description ol {
      margin: 0 0 12px;
      padding-left: 22px;
    }

    .detail-description li {
      margin: 2px 0;
      white-space: pre-wrap;
    }

    .detail-description h4,
    .detail-description h5,
    .detail-description h6 {
      color: var(--text-primary);
      font-size: 15px;
      margin: 0 0 8px;
    }

    .detail-description code {
      font-family: 'Space Mono', monospace;
      font-size: 0.88em;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 1px 4px;
    }

    .detail-description pre {
      margin: 0 0 12px;
      padding: 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow-x: auto;
    }

    .detail-description pre code {
      background: none;
      border: none;
      padding: 0;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre;
    }

    .detail-description a {
      color: var(--accent);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .detail-description.is-empty {
      color: var(--text-dimmed);
      font-style: italic;
    }

    .detail-sidebar {
      min-width: 0;
      border-left: 1px solid var(--border-subtle);
      padding-left: clamp(20px, 2vw, 32px);
    }

    .detail-meta {
      display: grid;
      grid-template-columns: 88px minmax(0, 1fr);
      gap: 9px 12px;
      margin: 0 0 20px;
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

    .detail-move {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-bottom: 16px;
    }

    .detail-move label,
    .detail-edit-form label {
      font-family: 'Space Mono', monospace;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--text-dimmed);
    }

    .detail-move select,
    .detail-edit-form input,
    .detail-edit-form textarea,
    .detail-edit-form select {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: 6px;
      color: var(--text-primary);
      font-family: 'DM Sans', sans-serif;
      font-size: 13px;
      outline: none;
      box-sizing: border-box;
      transition: border-color 0.2s ease;
    }

    .detail-move select:focus,
    .detail-edit-form input:focus,
    .detail-edit-form textarea:focus,
    .detail-edit-form select:focus {
      border-color: var(--accent);
    }

    .detail-actions,
    .detail-edit-actions {
      display: flex;
      gap: 8px;
    }

    .detail-actions button,
    .detail-edit-actions button {
      flex: 1;
      min-height: 34px;
      padding: 6px 10px;
      border-radius: 6px;
      border: none;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .detail-actions button:disabled,
    .detail-edit-actions button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--on-accent);
    }

    .btn-primary:hover:not(:disabled) {
      background: var(--accent-hover);
    }

    .btn-secondary {
      background: var(--btn-secondary-bg);
      color: var(--text-secondary);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--btn-secondary-hover);
    }

    .btn-danger-outline {
      background: transparent;
      border: 1px solid var(--border-input) !important;
      color: var(--delete-text);
    }

    .btn-danger-outline:hover:not(:disabled) {
      border-color: var(--delete-text) !important;
      background: var(--delete-bg);
    }

    .detail-edit-form {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .detail-edit-form textarea {
      resize: vertical;
      min-height: 390px;
      line-height: 1.5;
    }

    .detail-edit-row {
      display: flex;
      gap: 10px;
    }

    .detail-edit-row label {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .form-error {
      font-size: 12px;
      color: var(--error-text);
    }

    .confirm {
      width: min(440px, calc(100vw - 32px));
      padding: 22px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: var(--bg-surface);
      color: var(--text-primary);
      box-shadow: 0 16px 50px var(--shadow);
    }

    .confirm::backdrop {
      background: rgba(4, 4, 10, 0.62);
    }

    .confirm-title {
      font-family: 'Space Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      margin: 0 0 10px;
    }

    .confirm-body {
      margin: 0 0 16px;
      font-size: 14px;
      line-height: 1.5;
      color: var(--text-secondary);
      word-break: break-word;
    }

    .confirm-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .confirm-actions button {
      min-height: 34px;
      padding: 6px 14px;
      border-radius: 6px;
      border: none;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .btn-danger {
      background: var(--danger-solid-bg);
      color: var(--danger-solid-text);
    }

    .btn-danger:hover:not(:disabled) {
      filter: brightness(1.08);
    }

    .btn-danger:disabled {
      cursor: not-allowed;
      opacity: 0.6;
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

      .connection-text {
        display: none;
      }

      .header-controls {
        gap: 8px;
      }

      .theme-toggle {
        width: 30px;
        height: 30px;
        font-size: 14px;
      }

      .status-dot {
        width: 8px;
        height: 8px;
      }

      .stale-banner,
      .error-bar {
        padding: 6px 10px;
        font-size: 11px;
      }

      main {
        overflow: auto;
      }

      .task-detail {
        width: calc(100vw - 16px);
        max-height: 92dvh;
        border-radius: 12px;
      }

      .detail-header {
        padding: 10px 14px;
      }

      .detail-scroll {
        padding: 18px 16px 22px;
      }

      .detail-edit-row {
        flex-direction: column;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      :host,
      .status-dot,
      .theme-toggle,
      .copy-btn {
        transition: none;
      }

      .task-detail[open],
      .notice {
        animation: none;
      }
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this.initTheme();
    const initialTaskId = this.taskIdFromHash();
    if (initialTaskId)
      this.dispatch({ type: 'openView', taskId: initialTaskId });
    globalThis.addEventListener('hashchange', this.handleHashChange);
    globalThis.addEventListener('popstate', this.handleHashChange);
    this.clockTimer = globalThis.setInterval(() => {
      this.clock = Date.now();
    }, 5000);

    this.unsubscribe = this.boardSession.subscribe((snapshot) => {
      this.handleSnapshot(snapshot);
    });
    this.boardSession.start();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.boardSession.stop();
    globalThis.removeEventListener('hashchange', this.handleHashChange);
    globalThis.removeEventListener('popstate', this.handleHashChange);
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }

  updated() {
    this.syncDialogs();
  }

  // --- Theme ---

  private initTheme() {
    const stored = localStorage.getItem('kanbrawl-theme') as Theme | undefined;
    this.theme = stored ?? this.getDefaultTheme();
    this.applyTheme();
  }

  private getDefaultTheme(): Theme {
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
    document.documentElement.style.colorScheme = this.theme;
    document.body.style.background =
      this.theme === 'light' ? '#f2f0ed' : '#0a0a0f';
    document.body.style.color = this.theme === 'light' ? '#1a1a1a' : '#ebebeb';
  }

  // --- Board loading and live sync ---

  private message(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong.';
  }

  private conflictMessage(error: unknown): string {
    if (error instanceof ApiError && error.code === 'CONFLICT') {
      return 'This task changed while you were editing. Close and reopen it to see the latest version, then try again.';
    }

    return this.message(error);
  }

  private async refreshBoard(): Promise<void> {
    try {
      await this.boardSession.refresh();
      this.clearError();
    } catch (error) {
      this.setError(this.message(error), async () => this.refreshBoard());
    }
  }

  private handleSessionError(error: unknown) {
    this.setError(this.message(error), async () => this.refreshBoard());
  }

  private handleSnapshot(snapshot: BoardSnapshots) {
    this.session = snapshot;

    if (snapshot.lastSyncAt !== undefined) {
      this.boardLoaded = true;
      this.clock = Date.now();
    }

    const { theme } = snapshot.board;
    if (
      !localStorage.getItem('kanbrawl-theme') &&
      theme &&
      this.theme !== theme
    ) {
      this.theme = theme;
      this.applyTheme();
    }

    const openTaskId = this.selectedTaskId;
    if (
      this.boardLoaded &&
      openTaskId &&
      !snapshot.board.tasks.some((task) => task.id === openTaskId)
    ) {
      this.dispatch({ type: 'taskRemoved', taskId: openTaskId });
      this.syncHashAfterClose();
      this.notify('That task no longer exists. It may have been deleted.');
    }
  }

  private reconnectNow() {
    this.boardSession.stop();
    this.boardSession.start();
    void this.refreshBoard();
  }

  // --- Errors and notices ---

  private setError(message: string, retry?: () => Promise<void>) {
    this.error = {
      message,
      retry: retry
        ? () => {
            void this.runRetry(retry);
          }
        : undefined,
    };
  }

  private async runRetry(retry: () => Promise<void>) {
    try {
      await retry();
      this.clearError();
    } catch (error) {
      this.setError(this.message(error), retry);
    }
  }

  private clearError() {
    this.error &&= undefined;
  }

  private notify(text: string) {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = undefined;
      this.noticeTimer = undefined;
    }, 6000);
  }

  // --- Deep links ---

  private taskIdFromHash(): string | undefined {
    const match = /^#task\/(.+)$/.exec(globalThis.location.hash);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  private readonly handleHashChange = () => {
    const id = this.taskIdFromHash();
    if (!id) {
      this.pushedTaskEntry = false;
      this.dispatch({ type: 'close' });
      return;
    }

    if (id === this.selectedTaskId) return;

    this.dispatch({ type: 'openView', taskId: id });

    if (this.boardLoaded && !this.board.tasks.some((task) => task.id === id)) {
      this.dispatch({ type: 'close' });
      this.replaceHash();
      this.notify('That task no longer exists. It may have been deleted.');
    }
  };

  private replaceHash() {
    globalThis.history.replaceState(
      null,
      '',
      globalThis.location.pathname + globalThis.location.search,
    );
  }

  private syncHashAfterClose() {
    if (!this.taskIdFromHash()) {
      this.pushedTaskEntry = false;
      return;
    }

    if (this.pushedTaskEntry) {
      this.pushedTaskEntry = false;
      globalThis.history.back();
      return;
    }

    this.replaceHash();
  }

  private openTask(id: string) {
    if (this.selectedTaskId === id) return;
    this.dispatch({ type: 'openView', taskId: id });
    const hash = `#task/${id}`;
    if (globalThis.location.hash !== hash) {
      this.pushedTaskEntry = true;
      globalThis.location.hash = `task/${id}`;
    }
  }

  private handleViewTask(e: CustomEvent<{ task: Task }>) {
    this.openTask(e.detail.task.id);
  }

  private openCreate(column: string) {
    this.dispatch({ type: 'openCreate', column });
  }

  private handleCreateRequest(e: CustomEvent<{ column: string }>) {
    this.openCreate(e.detail.column);
  }

  private handleEditRequest(e: CustomEvent<{ task: Task }>) {
    this.openTask(e.detail.task.id);
    void this.startDetailEdit();
  }

  // --- Dialogs ---

  private get detailDialog(): HTMLDialogElement | undefined {
    return (
      this.renderRoot.querySelector<HTMLDialogElement>('dialog.task-detail') ??
      undefined
    );
  }

  private get confirmDialog(): HTMLDialogElement | undefined {
    return (
      this.renderRoot.querySelector<HTMLDialogElement>('dialog.confirm') ??
      undefined
    );
  }

  private syncDialogs() {
    const detail = this.detailDialog;
    if (detail) {
      if (this.dialog.mode !== 'closed') {
        if (!detail.open) {
          detail.showModal();
          const initial =
            this.dialog.mode === 'create' || this.dialog.mode === 'edit'
              ? detail.querySelector<HTMLInputElement>(
                  '.detail-edit-form input',
                )
              : detail.querySelector<HTMLElement>('.detail-close');
          initial?.focus();
        }
      } else if (detail.open) {
        detail.close();
      }
    }

    const confirm = this.confirmDialog;
    if (confirm) {
      if (this.pendingDelete) {
        if (!confirm.open) {
          confirm.showModal();
          confirm.querySelector<HTMLElement>('.btn-cancel-confirm')?.focus();
        }
      } else if (confirm.open) {
        confirm.close();
      }
    }
  }

  private closeDetailPanel() {
    const dialog = this.detailDialog;
    if (dialog?.open) {
      dialog.close();
    } else {
      this.handleDetailClose();
    }
  }

  private handleDetailClose() {
    this.dispatch({ type: 'close' });
    this.syncHashAfterClose();
  }

  private handleDetailBackdrop(e: MouseEvent) {
    if (this.detailPending) return;

    const dialog = e.currentTarget as HTMLDialogElement;
    if (e.target !== dialog) return;

    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) this.closeDetailPanel();
  }

  private taskIsStale(task: Task): boolean {
    const index = this.board.columns.findIndex(
      (column) => column.name === task.column,
    );
    if (index <= 0 || index >= this.board.columns.length - 1) return false;
    const updated = Date.parse(task.updatedAt);
    return Number.isFinite(updated) && this.clock - updated > STALE_AFTER_MS;
  }

  private formatTimestamp(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  // --- Task mutations ---

  private async saveCreate() {
    const { dialog } = this;
    if (dialog.mode !== 'create' || dialog.pending) return;

    const title = dialog.fields.title.trim();
    if (!title) {
      this.dispatch({ type: 'fail', message: 'Title is required.' });
      return;
    }

    this.dispatch({ type: 'submit' });
    try {
      await this.boardSession.createTask({
        title,
        description: dialog.fields.description,
        column: dialog.column,
        priority: dialog.fields.priority,
        assignee: dialog.fields.assignee.trim(),
        actor: 'web',
      });
      this.dispatch({ type: 'succeed' });
      this.closeDetailPanel();
      this.clearError();
    } catch (error) {
      this.dispatch({ type: 'fail', message: this.message(error) });
    }
  }

  private async handleUpdateTask(e: CustomEvent<UpdateTaskDetail>) {
    const { id, resolve, reject, ...fields } = e.detail;
    try {
      await this.boardSession.updateTask(id, { ...fields, actor: 'web' });
      resolve?.();
      this.clearError();
    } catch (error) {
      if (reject) {
        reject(this.message(error));
      } else {
        const retry = async () => {
          await this.boardSession.updateTask(id, { ...fields, actor: 'web' });
        };

        this.setError(this.message(error), retry);
      }
    }
  }

  private handleDeleteTask(e: CustomEvent<DeleteTaskDetail>) {
    this.deleteError = undefined;
    this.deletePending = false;
    this.pendingDelete = { id: e.detail.id, title: e.detail.title };
  }

  private requestDelete(task: Task) {
    this.deleteError = undefined;
    this.deletePending = false;
    this.pendingDelete = { id: task.id, title: task.title };
  }

  private cancelDelete() {
    this.pendingDelete = undefined;
    this.deleteError = undefined;
  }

  private async confirmDelete() {
    const target = this.pendingDelete;
    if (!target || this.deletePending) return;

    this.deletePending = true;
    this.deleteError = undefined;
    try {
      await this.boardSession.deleteTask(target.id);
      this.pendingDelete = undefined;
      this.deletePending = false;
      this.clearError();
      if (this.selectedTaskId === target.id) {
        this.closeDetailPanel();
      }

      this.notify(`Deleted “${target.title}”.`);
    } catch (error) {
      this.deletePending = false;
      this.deleteError = this.message(error);
    }
  }

  private async startDetailEdit() {
    const task = this.detailTask;
    if (!task) return;
    this.dispatch({ type: 'startEdit', task });
    await this.updateComplete;
    this.renderRoot
      .querySelector<HTMLInputElement>('.detail-edit-form input')
      ?.focus();
  }

  private cancelDetailEdit() {
    this.dispatch({ type: 'cancel' });
  }

  private async saveDetailEdit() {
    const { dialog } = this;
    if (dialog.mode !== 'edit' || dialog.pending) return;

    const title = dialog.fields.title.trim();
    if (!title) {
      this.dispatch({ type: 'fail', message: 'Title is required.' });
      return;
    }

    this.dispatch({ type: 'submit' });
    try {
      await this.boardSession.updateTask(dialog.base.id, {
        title,
        description: dialog.fields.description,
        priority: dialog.fields.priority,
        assignee: dialog.fields.assignee.trim(),
        actor: 'web',
        expectedUpdatedAt: dialog.base.updatedAt,
      });
      this.dispatch({ type: 'succeed' });
      this.clearError();
    } catch (error) {
      this.dispatch({ type: 'fail', message: this.conflictMessage(error) });
    }
  }

  private async moveTaskFromDetail(
    task: Task,
    column: string,
    select: HTMLSelectElement,
  ) {
    if (column === task.column) {
      select.value = task.column;
      return;
    }

    try {
      await this.boardSession.updateTask(task.id, {
        column,
        actor: 'web',
        expectedUpdatedAt: task.updatedAt,
      });
      this.clearError();
    } catch (error) {
      select.value = task.column;
      this.setError(this.conflictMessage(error));
    }
  }

  private async copyToClipboard(text: string): Promise<boolean> {
    // Clipboard API needs a secure context; the board may be served over
    // plain HTTP on the LAN, so fall back to the selection-based copy.
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }

    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      // Still the only copy path in non-secure contexts, where the Clipboard
      // API is unavailable.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      return document.execCommand('copy');
    } finally {
      area.remove();
    }
  }

  private async copyTaskId(id: string) {
    try {
      if (!(await this.copyToClipboard(id))) {
        throw new Error('clipboard unavailable');
      }

      this.copiedId = id;
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => {
        this.copiedId = undefined;
        this.copiedTimer = undefined;
      }, 2000);
    } catch {
      this.notify('Copy failed. Select the ID and copy it manually.');
    }
  }

  private async handleUpdateColumns(e: CustomEvent<UpdateColumnsDetail>) {
    const { columns, moveTo, resolve, reject } = e.detail;
    try {
      await this.boardSession.updateColumns(columns, moveTo);
      resolve?.();
      this.clearError();
    } catch (error) {
      reject?.(this.message(error));
    }
  }

  // --- Rendering ---

  private get connectionLabel(): string {
    if (this.connection === 'online') return 'Live';
    if (this.connection === 'offline') return 'Offline';
    return 'Connecting…';
  }

  private get connectionTitle(): string {
    if (this.lastSyncAt === undefined) return '';
    return `Last sync ${new Date(this.lastSyncAt).toLocaleTimeString(
      undefined,
      { timeStyle: 'medium' },
    )}`;
  }

  private get showStaleBanner(): boolean {
    if (this.connection !== 'offline') return false;
    if (this.lastSyncAt === undefined) return this.clock > 0;
    return this.clock - this.lastSyncAt > OFFLINE_BANNER_AFTER_MS;
  }

  private staleBannerText(): string {
    if (this.lastSyncAt === undefined) {
      return 'Cannot reach the board server. Retrying…';
    }

    return `Live updates paused. Showing data from ${new Date(
      this.lastSyncAt,
    ).toLocaleTimeString(undefined, {
      timeStyle: 'short',
    })} — the board may be out of date.`;
  }

  private renderConnection() {
    return html`
      <div
        class="connection"
        role="status"
        aria-live="polite"
        title=${this.connectionTitle}
      >
        <span class="status-dot ${this.connection}"></span>
        <span class="connection-text">${this.connectionLabel}</span>
      </div>
    `;
  }

  private renderTaskForm(
    fields: TaskFields,
    options: {
      submitLabel: string;
      pendingLabel: string;
      onChange: (patch: Partial<TaskFields>) => void;
      onSubmit: () => void;
      onCancel: () => void;
    },
  ) {
    return html`
      <form
        class="detail-edit-form"
        @submit=${(e: Event) => {
          e.preventDefault();
          options.onSubmit();
        }}
      >
        <label for="task-form-title">Title</label>
        <input
          id="task-form-title"
          type="text"
          maxlength=${LIMITS.title}
          placeholder="Task title"
          .value=${fields.title}
          ?disabled=${this.detailPending}
          @input=${(e: InputEvent) => {
            options.onChange({ title: (e.target as HTMLInputElement).value });
          }}
        />
        <label for="task-form-description">Description</label>
        <textarea
          id="task-form-description"
          maxlength=${LIMITS.description}
          placeholder="Description (optional)"
          .value=${fields.description}
          ?disabled=${this.detailPending}
          @input=${(e: InputEvent) => {
            options.onChange({
              description: (e.target as HTMLTextAreaElement).value,
            });
          }}
        ></textarea>
        <div class="detail-edit-row">
          <label for="task-form-priority">
            Priority
            <select
              id="task-form-priority"
              .value=${fields.priority}
              ?disabled=${this.detailPending}
              @change=${(e: Event) => {
                options.onChange({
                  priority: (e.target as HTMLSelectElement).value as Priority,
                });
              }}
            >
              <option value="P0">P0 — Critical</option>
              <option value="P1">P1 — Normal</option>
              <option value="P2">P2 — Low</option>
            </select>
          </label>
          <label for="task-form-assignee">
            Assignee
            <input
              id="task-form-assignee"
              type="text"
              maxlength=${LIMITS.assignee}
              placeholder="Name (optional)"
              .value=${fields.assignee}
              ?disabled=${this.detailPending}
              @input=${(e: InputEvent) => {
                options.onChange({
                  assignee: (e.target as HTMLInputElement).value,
                });
              }}
            />
          </label>
        </div>
        ${this.detailError
          ? html`<div class="form-error" role="alert">${this.detailError}</div>`
          : nothing}
        <div class="detail-edit-actions">
          <button
            type="submit"
            class="btn-primary"
            ?disabled=${this.detailPending || !fields.title.trim()}
          >
            ${this.detailPending ? options.pendingLabel : options.submitLabel}
          </button>
          <button
            type="button"
            class="btn-secondary"
            ?disabled=${this.detailPending}
            @click=${options.onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    `;
  }

  private renderComposer(draft: Extract<TaskDialogState, { mode: 'create' }>) {
    return html`
      <div class="detail-layout">
        <div class="detail-main">
          ${this.renderTaskForm(draft.fields, {
            submitLabel: 'Add task',
            pendingLabel: 'Adding…',
            onChange: (patch) => {
              this.dispatch({ type: 'change', patch });
            },
            onSubmit: () => {
              void this.saveCreate();
            },
            onCancel: () => {
              this.closeDetailPanel();
            },
          })}
        </div>
        <aside class="detail-sidebar" aria-label="New task placement">
          <h3 class="detail-section-label">Details</h3>
          <div class="detail-move">
            <label for="task-form-column">Column</label>
            <select
              id="task-form-column"
              ?disabled=${this.detailPending}
              .value=${draft.column}
              @change=${(e: Event) => {
                this.dispatch({
                  type: 'change',
                  patch: { column: (e.target as HTMLSelectElement).value },
                });
              }}
            >
              ${this.board.columns.map(
                (column) =>
                  html`<option value=${column.name}>${column.name}</option>`,
              )}
            </select>
          </div>
        </aside>
      </div>
    `;
  }

  private renderDetailContent(task: Task) {
    return html`
      <div class="detail-badges">
        <span class="detail-badge priority-${task.priority}"
          >${task.priority}</span
        >
        <span class="detail-badge column">${task.column}</span>
        ${this.taskIsStale(task)
          ? html`<span
              class="detail-stale"
              title="Last updated ${this.formatTimestamp(task.updatedAt)}"
              >stale</span
            >`
          : nothing}
      </div>
      <h2 class="detail-task-title" id="detail-title">${task.title}</h2>
      <div class="detail-id-row">
        <code class="detail-id" title="Task ID">${task.id}</code>
        <button
          class="copy-btn"
          aria-label="Copy task ID"
          @click=${() => {
            void this.copyTaskId(task.id);
          }}
        >
          ${this.copiedId === task.id ? 'Copied' : 'Copy ID'}
        </button>
      </div>
      <section aria-labelledby="detail-description-label">
        <h3 class="detail-section-label" id="detail-description-label">
          Description
        </h3>
        ${task.description.trim()
          ? html`<div class="detail-description">
              ${renderMarkdown(task.description)}
            </div>`
          : html`<div class="detail-description is-empty">
              No description.
            </div>`}
      </section>
    `;
  }

  private renderDetailSidebar(task: Task) {
    return html`
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
        <dt>Changed by</dt>
        <dd>${task.lastActor || '—'}</dd>
      </dl>
      <div class="detail-move">
        <label for="detail-move-select">Move to</label>
        <select
          id="detail-move-select"
          ?disabled=${this.editing}
          .value=${task.column}
          @change=${(e: Event) => {
            const select = e.target as HTMLSelectElement;
            void this.moveTaskFromDetail(task, select.value, select);
          }}
        >
          ${this.board.columns.map(
            (column) =>
              html`<option value=${column.name}>${column.name}</option>`,
          )}
        </select>
      </div>
      <div class="detail-actions">
        <button
          class="btn-primary"
          ?disabled=${this.editing}
          @click=${this.startDetailEdit}
        >
          Edit
        </button>
        <button
          class="btn-danger-outline"
          ?disabled=${this.detailPending}
          @click=${() => {
            this.requestDelete(task);
          }}
        >
          Delete
        </button>
      </div>
    `;
  }

  private renderDetailDialog() {
    const { dialog } = this;
    const task = this.detailTask;
    const heading =
      dialog.mode === 'create'
        ? 'New task'
        : dialog.mode === 'edit'
          ? 'Edit task'
          : 'Task detail';
    return html`
      <dialog
        class="task-detail"
        aria-labelledby="detail-dialog-title"
        @click=${this.handleDetailBackdrop}
        @close=${this.handleDetailClose}
        @cancel=${(e: Event) => {
          if (this.detailPending) e.preventDefault();
        }}
      >
        ${dialog.mode === 'create' || task
          ? html`
              <div class="detail-header">
                <span class="detail-header-title" id="detail-dialog-title"
                  >${heading}</span
                >
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
                ${dialog.mode === 'create'
                  ? this.renderComposer(dialog)
                  : task
                    ? html`
                        <div class="detail-layout">
                          <div class="detail-main">
                            ${dialog.mode === 'edit'
                              ? this.renderTaskForm(dialog.fields, {
                                  submitLabel: 'Save',
                                  pendingLabel: 'Saving…',
                                  onChange: (patch) => {
                                    this.dispatch({ type: 'change', patch });
                                  },
                                  onSubmit: () => {
                                    void this.saveDetailEdit();
                                  },
                                  onCancel: this.cancelDetailEdit,
                                })
                              : this.renderDetailContent(task)}
                          </div>
                          <aside
                            class="detail-sidebar"
                            aria-label="Task metadata"
                          >
                            ${this.renderDetailSidebar(task)}
                          </aside>
                        </div>
                      `
                    : nothing}
              </div>
            `
          : nothing}
      </dialog>
    `;
  }

  private renderConfirmDialog() {
    const target = this.pendingDelete;
    return html`
      <dialog
        class="confirm"
        aria-labelledby="confirm-title"
        @close=${() => {
          this.pendingDelete = undefined;
          this.deleteError = undefined;
          this.deletePending = false;
        }}
        @cancel=${(e: Event) => {
          if (this.deletePending) e.preventDefault();
        }}
      >
        ${target
          ? html`
              <h2 class="confirm-title" id="confirm-title">Delete task?</h2>
              <p class="confirm-body">
                “${target.title}” will be permanently deleted. This cannot be
                undone.
              </p>
              ${this.deleteError
                ? html`<div
                    class="form-error"
                    role="alert"
                    style="margin-bottom: 12px"
                  >
                    ${this.deleteError}
                  </div>`
                : nothing}
              <div class="confirm-actions">
                <button
                  class="btn-secondary btn-cancel-confirm"
                  ?disabled=${this.deletePending}
                  @click=${this.cancelDelete}
                >
                  Cancel
                </button>
                <button
                  class="btn-danger"
                  ?disabled=${this.deletePending}
                  @click=${() => {
                    void this.confirmDelete();
                  }}
                >
                  ${this.deletePending ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            `
          : nothing}
      </dialog>
    `;
  }

  render() {
    return html`
      <header>
        <div class="logo">
          <span class="logo-icon">🥊</span>
          <h1>Kanbrawl</h1>
          ${this.renderConnection()}
        </div>
        <div class="header-controls">
          <kanbrawl-column-settings
            .columns=${this.board.columns}
            .tasks=${this.board.tasks}
            @update-columns=${this.handleUpdateColumns}
          ></kanbrawl-column-settings>
          <button
            class="theme-toggle"
            title="Toggle theme"
            aria-label="Toggle color theme"
            @click=${this.toggleTheme}
          >
            ${this.theme === 'dark' ? '☀️' : '🌙'}
          </button>
        </div>
      </header>
      ${this.showStaleBanner
        ? html`<div class="stale-banner" role="status">
            <span>${this.staleBannerText()}</span>
            <button @click=${this.reconnectNow}>Retry</button>
          </div>`
        : nothing}
      ${this.error
        ? html`<div class="error-bar" role="alert">
            <span class="error-message">${this.error.message}</span>
            ${this.error.retry
              ? html`<button @click=${this.error.retry}>Retry</button>`
              : nothing}
            <button @click=${this.clearError}>Dismiss</button>
          </div>`
        : nothing}
      <main>
        <div class="board-area">
          <kanbrawl-board
            .columns=${this.board.columns}
            .tasks=${this.board.tasks}
            @create-task-request=${this.handleCreateRequest}
            @update-task=${this.handleUpdateTask}
            @delete-task=${this.handleDeleteTask}
            @view-task=${this.handleViewTask}
            @edit-task=${this.handleEditRequest}
          ></kanbrawl-board>
        </div>
      </main>
      ${this.notice
        ? html`<div class="notice" role="status">
            <span>${this.notice}</span>
            <button
              aria-label="Dismiss notification"
              @click=${() => {
                this.notice = undefined;
              }}
            >
              ✕
            </button>
          </div>`
        : nothing}
      ${this.renderDetailDialog()} ${this.renderConfirmDialog()}
    `;
  }
}
