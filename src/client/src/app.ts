import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import {
  LIMITS,
  type AttachmentMeta,
  type Board,
  type Priority,
  type Project,
  type Task,
  type Column,
} from '../../shared/board.js';
import {
  fetchBoard,
  createTask,
  updateTask,
  deleteTask,
  updateColumns,
  updateProjects,
  addAttachment,
  deleteAttachment,
  attachmentUrl,
  ApiError,
} from './api.js';
import {
  BoardSession,
  type BoardCommands,
  type BoardSnapshots,
  type ConnectionStatus,
} from './board-session.js';
import { EventSourceTransport } from './event-source-transport.js';
import {
  transition,
  type StagedImage,
  type TaskDialogAction,
  type TaskDialogState,
  type TaskFields,
} from './task-dialog.js';
import {
  createFilter,
  hiddenTaskCount,
  isTaskVisible,
  pruneFilter,
  toggleAllProjects,
  toggleProjectFilter,
  unclassifiedTaskCount,
  type TaskFilter,
} from './task-filter.js';
import './components/column-settings.js';
import './components/filter-bar.js';
import './components/app-button.js';
import './components/app-badge.js';
import './components/app-banner.js';

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

type UpdateProjectsDetail = {
  projects: Project[];
  expectedRevision?: number;
} & ResultCallbacks;

type ErrorState = { message: string; retry?: () => void };

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const OFFLINE_BANNER_AFTER_MS = 8000;

function makeRequestId(): string {
  const { crypto } = globalThis;
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  // Crypto.randomUUID needs a secure context; the LAN board is plain HTTP.
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const apiCommands: BoardCommands = {
  fetchBoard,
  createTask,
  updateTask,
  deleteTask,
  updateColumns,
  updateProjects,
  addAttachment,
  deleteAttachment: async (_taskId, attachmentId) =>
    deleteAttachment(attachmentId),
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
    board: { columns: [], projects: [], projectsRevision: 0, tasks: [] },
    connection: 'connecting',
  };

  @state() private clock = Date.now();
  @state() private error: ErrorState | undefined;
  @state() private theme: Theme = 'dark';
  @state() private notice:
    | { text: string; actionLabel?: string; action?: () => void }
    | undefined;

  @state() private taskFilter: TaskFilter = createFilter();
  @state() private dialog: TaskDialogState = { mode: 'closed' };
  @state() private copiedId: string | undefined;
  @state() private pendingDelete: { id: string; title: string } | undefined;
  @state() private deletePending = false;
  @state() private deleteError: string | undefined;
  @state() private viewer: AttachmentMeta | undefined;
  @state() private imageBusy = false;

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
  private createRequestId: string | undefined;

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

    .banner-action {
      flex-shrink: 0;
    }

    .banner-action::part(button) {
      border-color: currentColor;
      border-radius: 5px;
      color: inherit;
    }

    .banner-action::part(button):hover:enabled {
      background: color-mix(in srgb, currentColor 12%, transparent);
      color: inherit;
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

    .notice kanbrawl-button::part(button) {
      min-width: 24px;
      min-height: 24px;
      font-size: 14px;
      color: var(--text-muted);
    }

    .notice kanbrawl-button::part(button):hover {
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

    .detail-actions kanbrawl-button,
    .detail-edit-actions kanbrawl-button {
      flex: 1;
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

    /* ── Attachments ── */
    .attachments {
      margin-top: 20px;
    }

    .attachment-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 10px;
    }

    .attachment-thumb {
      position: relative;
      display: inline-flex;
      width: 84px;
      height: 84px;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-input);
    }

    .attachment-thumb img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .attachment-open {
      width: 100%;
      height: 100%;
    }

    .attachment-open::part(button) {
      width: 100%;
      height: 100%;
      cursor: zoom-in;
    }

    .attachment-open::part(button):focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .attachment-remove {
      position: absolute;
      top: 4px;
      right: 4px;
    }

    .attachment-remove::part(button) {
      min-width: 22px;
      min-height: 22px;
      border: none;
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.6);
      color: #ffffff;
      font-size: 11px;
    }

    .attachment-remove::part(button):hover:not(:disabled) {
      background: var(--danger-solid-bg);
      box-shadow: none;
      filter: none;
    }

    .attachments-empty {
      font-size: 12px;
      color: var(--text-muted);
    }

    .attachments-drop {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px dashed var(--border-default);
      border-radius: 8px;
      background: var(--bg-input);
    }

    .attachments-hint {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .attachment-add-icon {
      flex-shrink: 0;
    }

    .image-viewer {
      border: none;
      border-radius: 12px;
      padding: 16px;
      background: var(--bg-elevated);
      color: var(--text-primary);
      max-width: min(92vw, 1100px);
      max-height: 90vh;
    }

    .image-viewer::backdrop {
      background: rgba(0, 0, 0, 0.75);
    }

    .image-viewer figure {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin: 0;
    }

    .image-viewer img {
      display: block;
      max-width: min(88vw, 1060px);
      max-height: 76vh;
      object-fit: contain;
      border-radius: 8px;
    }

    .image-viewer figcaption {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
    }

    @media (prefers-reduced-motion: reduce) {
      :host,
      .status-dot {
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
    const previous = this.session.board;
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

    this.syncQuickFilter(previous, snapshot.board);
    this.announceFilterHides(previous, snapshot.board);
  }

  /**
   * Re-syncs the quick-filter selection whenever the project catalog changes,
   * including changes made remotely (another client, an agent over MCP).
   */
  private syncQuickFilter(previous: Board, board: Board) {
    const ids = board.projects.map((project) => project.id);
    const unchanged =
      previous.projects.length === board.projects.length &&
      previous.projects.every((project, index) => project.id === ids[index]);
    if (unchanged) return;
    this.taskFilter = pruneFilter(this.taskFilter, ids);
  }

  /**
   * Announces tasks whose project change hid them from the current filter.
   * Every change — local or remote — flows through the same snapshots, so a
   * single detector here covers both without double announces.
   */
  private announceFilterHides(previous: Board, board: Board) {
    const before = new Map(previous.tasks.map((task) => [task.id, task]));
    for (const task of board.tasks) {
      const earlier = before.get(task.id);
      if (!earlier || earlier.projectId === task.projectId) continue;
      if (
        isTaskVisible(this.taskFilter, earlier) &&
        !isTaskVisible(this.taskFilter, task)
      ) {
        this.announceFilteredOut(earlier, task);
      }
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
    this.notifyWithAction(text);
  }

  private notifyWithAction(
    text: string,
    actionLabel?: string,
    action?: () => void,
  ) {
    this.notice = { text, actionLabel, action };
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
    this.createRequestId = undefined;
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

  private get viewerDialog(): HTMLDialogElement | undefined {
    return (
      this.renderRoot.querySelector<HTMLDialogElement>('dialog.image-viewer') ??
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

    const viewer = this.viewerDialog;
    if (viewer) {
      if (this.viewer) {
        if (!viewer.open) viewer.showModal();
      } else if (viewer.open) {
        viewer.close();
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
    this.clearStagedImages();
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

  private formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
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

    const { projectId } = dialog.fields;
    if (!projectId) {
      this.dispatch({ type: 'fail', message: 'Project is required.' });
      return;
    }

    this.createRequestId ??= makeRequestId();
    this.dispatch({ type: 'submit' });
    try {
      const task = await this.boardSession.createTask({
        title,
        description: dialog.fields.description,
        column: dialog.column,
        priority: dialog.fields.priority,
        assignee: dialog.fields.assignee.trim(),
        projectId,
        actor: 'web',
        clientRequestId: this.createRequestId,
      });
      const { images } = dialog;
      this.clearStagedImages();
      this.dispatch({ type: 'succeed' });
      this.closeDetailPanel();
      this.clearError();
      await this.uploadImages(
        task,
        images.map((image) => ({ name: image.name, body: image.body })),
      );
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

    const { projectId } = dialog.fields;
    if (!projectId) {
      this.dispatch({ type: 'fail', message: 'Project is required.' });
      return;
    }

    this.dispatch({ type: 'submit' });
    try {
      await this.boardSession.updateTask(dialog.base.id, {
        title,
        description: dialog.fields.description,
        priority: dialog.fields.priority,
        assignee: dialog.fields.assignee.trim(),
        projectId,
        actor: 'web',
        expectedUpdatedAt: dialog.base.updatedAt,
      });
      this.dispatch({ type: 'succeed' });
      this.clearError();
    } catch (error) {
      this.dispatch({ type: 'fail', message: this.conflictMessage(error) });
    }
  }

  // --- Task images ---

  private get stagedImages(): StagedImage[] {
    return this.dialog.mode === 'create' ? this.dialog.images : [];
  }

  private clearStagedImages() {
    for (const image of this.stagedImages) {
      URL.revokeObjectURL(image.previewUrl);
    }

    this.createRequestId = undefined;
  }

  private stageFiles(files: Iterable<File>) {
    const images: StagedImage[] = [];
    for (const file of files) {
      if (file.type && !file.type.startsWith('image/')) continue;
      images.push({
        name: file.name || 'image',
        size: file.size,
        previewUrl: URL.createObjectURL(file),
        body: file,
      });
    }

    if (images.length > 0) {
      this.dispatch({ type: 'stage', images });
    }
  }

  private unstageImage(index: number) {
    const image = this.stagedImages[index];
    if (image) URL.revokeObjectURL(image.previewUrl);
    this.dispatch({ type: 'unstage', index });
  }

  private handleImageFiles(files: Iterable<File>) {
    const list = [...files];
    if (this.dialog.mode === 'create') {
      this.stageFiles(list);
      return;
    }

    const task = this.detailTask;
    if (task) {
      void this.uploadImages(
        task,
        list.map((file) => ({ name: file.name, body: file })),
      );
    }
  }

  private async uploadImages(
    task: Task,
    images: Array<{ name?: string; body: Blob | Uint8Array }>,
  ) {
    if (images.length === 0) return;
    this.imageBusy = true;
    try {
      for (const image of images) {
        // Uploads run one at a time so a failure stops the batch predictably.
        // eslint-disable-next-line no-await-in-loop
        await this.boardSession.addAttachment(task.id, {
          name: image.name,
          body: image.body,
        });
      }
    } catch (error) {
      this.setError(this.message(error));
    } finally {
      this.imageBusy = false;
    }
  }

  private async removeAttachment(task: Task, meta: AttachmentMeta) {
    this.imageBusy = true;
    try {
      await this.boardSession.deleteAttachment(task.id, meta.id);
    } catch (error) {
      this.setError(this.message(error));
    } finally {
      this.imageBusy = false;
    }
  }

  private handleAttachmentInput(e: Event) {
    const input = e.target as HTMLInputElement;
    // The FileList is a live view: copy before resetting the input.
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length > 0) this.handleImageFiles(files);
  }

  private handleAttachmentDrop(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) {
      this.handleImageFiles(e.dataTransfer.files);
    }
  }

  private handleDetailPaste(e: ClipboardEvent) {
    const files = e.clipboardData?.files;
    if (!files?.length) return;
    e.preventDefault();
    this.handleImageFiles(files);
  }

  private openAttachmentPicker() {
    this.renderRoot
      .querySelector<HTMLInputElement>('dialog.task-detail .attachment-input')
      ?.click();
  }

  private openViewer(meta: AttachmentMeta) {
    this.viewer = meta;
  }

  private closeViewer() {
    this.viewer = undefined;
  }

  private handleViewerBackdrop(e: MouseEvent) {
    const dialog = e.currentTarget as HTMLDialogElement;
    if (e.target !== dialog) return;
    this.closeViewer();
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

  private async handleUpdateProjects(e: CustomEvent<UpdateProjectsDetail>) {
    const { projects, expectedRevision, resolve, reject } = e.detail;
    try {
      await this.boardSession.updateProjects(projects, expectedRevision);
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
        <label for="task-form-project">Project</label>
        <select
          id="task-form-project"
          .value=${fields.projectId}
          ?disabled=${this.detailPending}
          @change=${(e: Event) => {
            options.onChange({
              projectId: (e.target as HTMLSelectElement).value,
            });
          }}
        >
          <option value="" disabled>
            ${this.board.projects.length > 0
              ? 'Choose a project…'
              : 'No projects yet — add one in board settings'}
          </option>
          ${[...this.board.projects]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(
              (project) =>
                html`<option value=${project.id}>${project.name}</option>`,
            )}
        </select>
        ${this.detailError
          ? html`<div class="form-error" role="alert">${this.detailError}</div>`
          : nothing}
        <div class="detail-edit-actions">
          <kanbrawl-button
            type="submit"
            class="btn-primary"
            variant="primary"
            ?disabled=${this.detailPending ||
            !fields.title.trim() ||
            !fields.projectId}
          >
            ${this.detailPending ? options.pendingLabel : options.submitLabel}
          </kanbrawl-button>
          <kanbrawl-button
            type="button"
            class="btn-secondary"
            variant="secondary"
            ?disabled=${this.detailPending}
            @click=${options.onCancel}
          >
            Cancel
          </kanbrawl-button>
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
          ${this.renderAttachments()}
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
        <kanbrawl-badge
          class="detail-badge priority-${task.priority}"
          tone=${task.priority}
          >${task.priority}</kanbrawl-badge
        >
        <kanbrawl-badge class="detail-badge column" tone="neutral"
          >${task.column}</kanbrawl-badge
        >
        <kanbrawl-badge class="detail-badge project" tone="neutral"
          >${this.projectNameOf(task)}</kanbrawl-badge
        >
        ${this.taskIsStale(task)
          ? html`<kanbrawl-badge
              class="detail-stale"
              tone="stale"
              title="Last updated ${this.formatTimestamp(task.updatedAt)}"
              >stale</kanbrawl-badge
            >`
          : nothing}
      </div>
      <h2 class="detail-task-title" id="detail-title">${task.title}</h2>
      <div class="detail-id-row">
        <code class="detail-id" title="Task ID">${task.id}</code>
        <kanbrawl-button
          class="copy-btn"
          variant="outline"
          size="sm"
          aria-label="Copy task ID"
          @click=${() => {
            void this.copyTaskId(task.id);
          }}
        >
          ${this.copiedId === task.id ? 'Copied' : 'Copy ID'}
        </kanbrawl-button>
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

  private projectNameOf(task: Task): string {
    return (
      this.board.projects.find((project) => project.id === task.projectId)
        ?.name ?? 'no project'
    );
  }

  // --- Quick filters ---

  private get filterProjectIds(): string[] {
    return this.board.projects.map((project) => project.id);
  }

  private get filteredTasks(): Task[] {
    return this.board.tasks.filter((task) =>
      isTaskVisible(this.taskFilter, task),
    );
  }

  private handleToggleAllProjects() {
    this.taskFilter = toggleAllProjects(this.taskFilter, this.filterProjectIds);
  }

  private handleToggleProjectFilter(e: CustomEvent<string>) {
    this.taskFilter = toggleProjectFilter(
      this.taskFilter,
      e.detail,
      this.filterProjectIds,
    );
  }

  private handleShowAllProjects() {
    this.taskFilter = createFilter();
  }

  /** Announces a task that just left the current filter, keeping it reachable. */
  private announceFilteredOut(before: Task | undefined, after: Task) {
    if (!before) return;
    if (
      !isTaskVisible(this.taskFilter, before) ||
      isTaskVisible(this.taskFilter, after)
    ) {
      return;
    }

    this.notifyWithAction(
      `“${after.title}” moved to ${this.projectNameOf(after)} — hidden by the current filter.`,
      'Open',
      () => {
        this.openTask(after.id);
      },
    );
  }

  private renderDetailSidebar(task: Task) {
    return html`
      <h3 class="detail-section-label">Details</h3>
      <dl class="detail-meta">
        <dt>Assignee</dt>
        <dd>${task.assignee || '—'}</dd>
        <dt>Project</dt>
        <dd>${this.projectNameOf(task)}</dd>
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
        <kanbrawl-button
          class="btn-primary"
          variant="primary"
          ?disabled=${this.editing}
          @click=${this.startDetailEdit}
        >
          Edit
        </kanbrawl-button>
        <kanbrawl-button
          class="btn-danger-outline"
          variant="danger-outline"
          ?disabled=${this.detailPending}
          @click=${() => {
            this.requestDelete(task);
          }}
        >
          Delete
        </kanbrawl-button>
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
        @paste=${this.handleDetailPaste}
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
                <kanbrawl-button
                  class="detail-close"
                  variant="outline"
                  icon
                  title="Close"
                  aria-label="Close task details"
                  @click=${this.closeDetailPanel}
                >
                  ✕
                </kanbrawl-button>
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
                            ${this.renderAttachments()}
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

  private renderAttachments() {
    return html`
      <section class="attachments" aria-label="Images">
        <h3 class="detail-section-label">Images</h3>
        ${this.dialog.mode === 'create'
          ? this.renderStagedThumbs()
          : this.renderTaskThumbs(this.detailTask)}
        <div
          class="attachments-drop"
          @dragover=${(e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          }}
          @drop=${this.handleAttachmentDrop}
        >
          <input
            class="attachment-input"
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            @change=${this.handleAttachmentInput}
          />
          <kanbrawl-button
            class="attachment-add"
            variant="outline"
            size="sm"
            ?disabled=${this.imageBusy || this.detailPending}
            @click=${this.openAttachmentPicker}
          >
            <svg
              class="attachment-add-icon"
              viewBox="0 0 12 12"
              width="11"
              height="11"
              aria-hidden="true"
            >
              <path
                d="M6 1.5v9M1.5 6h9"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
              />
            </svg>
            Add image
          </kanbrawl-button>
          <span class="attachments-hint">
            Drop, paste or pick — PNG, JPEG, GIF or WebP, up to
            ${LIMITS.attachmentsPerTask} images per task
          </span>
        </div>
      </section>
    `;
  }

  private renderStagedThumbs() {
    return html`
      <div class="attachment-grid">
        ${this.stagedImages.map(
          (image, index) => html`
            <span class="attachment-thumb">
              <img
                src=${image.previewUrl}
                alt=${image.name}
                title=${image.name}
              />
              <kanbrawl-button
                type="button"
                class="attachment-remove"
                variant="danger"
                icon
                size="sm"
                title="Remove ${image.name}"
                aria-label="Remove ${image.name}"
                ?disabled=${this.detailPending}
                @click=${() => {
                  this.unstageImage(index);
                }}
              >
                ✕
              </kanbrawl-button>
            </span>
          `,
        )}
      </div>
    `;
  }

  private renderTaskThumbs(task?: Task) {
    const attachments = task?.attachments ?? [];
    return html`
      <div class="attachment-grid">
        ${attachments.map(
          (meta) => html`
            <span class="attachment-thumb">
              <kanbrawl-button
                type="button"
                class="attachment-open"
                variant="plain"
                block
                title=${meta.filename}
                @click=${() => {
                  this.openViewer(meta);
                }}
              >
                <img
                  src=${attachmentUrl(meta.id)}
                  alt=${meta.filename}
                  loading="lazy"
                />
              </kanbrawl-button>
              <kanbrawl-button
                type="button"
                class="attachment-remove"
                variant="danger"
                icon
                size="sm"
                title="Delete ${meta.filename}"
                aria-label="Delete ${meta.filename}"
                ?disabled=${this.imageBusy}
                @click=${() => {
                  if (task) void this.removeAttachment(task, meta);
                }}
              >
                ✕
              </kanbrawl-button>
            </span>
          `,
        )}
        ${attachments.length === 0
          ? html`<span class="attachments-empty">No images yet.</span>`
          : nothing}
      </div>
    `;
  }

  private renderViewer() {
    const meta = this.viewer;
    return html`
      <dialog
        class="image-viewer"
        aria-label="Image viewer"
        @click=${this.handleViewerBackdrop}
        @close=${this.closeViewer}
      >
        ${meta
          ? html`
              <figure>
                <img src=${attachmentUrl(meta.id)} alt=${meta.filename} />
                <figcaption>
                  <span>${meta.filename}</span>
                  <span class="viewer-size"
                    >${this.formatBytes(meta.size)}</span
                  >
                </figcaption>
              </figure>
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
                <kanbrawl-button
                  class="btn-secondary btn-cancel-confirm"
                  variant="secondary"
                  ?disabled=${this.deletePending}
                  @click=${this.cancelDelete}
                >
                  Cancel
                </kanbrawl-button>
                <kanbrawl-button
                  class="btn-danger"
                  variant="danger"
                  ?disabled=${this.deletePending}
                  @click=${() => {
                    void this.confirmDelete();
                  }}
                >
                  ${this.deletePending ? 'Deleting…' : 'Delete'}
                </kanbrawl-button>
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
            .projects=${this.board.projects}
            .projectsRevision=${this.board.projectsRevision}
            .tasks=${this.board.tasks}
            @update-columns=${this.handleUpdateColumns}
            @update-projects=${this.handleUpdateProjects}
          ></kanbrawl-column-settings>
          <kanbrawl-button
            class="theme-toggle"
            variant="outline"
            icon
            title="Toggle theme"
            aria-label="Toggle color theme"
            @click=${this.toggleTheme}
          >
            ${this.theme === 'dark' ? '☀️' : '🌙'}
          </kanbrawl-button>
        </div>
      </header>
      ${this.showStaleBanner
        ? html`<kanbrawl-banner
            class="stale-banner"
            tone="warning"
            role="status"
          >
            <span>${this.staleBannerText()}</span>
            <kanbrawl-button
              slot="actions"
              class="banner-action"
              variant="ghost"
              size="sm"
              @click=${this.reconnectNow}
            >
              Retry
            </kanbrawl-button>
          </kanbrawl-banner>`
        : nothing}
      ${this.error
        ? html`<kanbrawl-banner class="error-bar" tone="error" role="alert">
            <span class="error-message">${this.error.message}</span>
            ${this.error.retry
              ? html`<kanbrawl-button
                  slot="actions"
                  class="banner-action"
                  variant="ghost"
                  size="sm"
                  @click=${this.error.retry}
                >
                  Retry
                </kanbrawl-button>`
              : nothing}
            <kanbrawl-button
              slot="actions"
              class="banner-action"
              variant="ghost"
              size="sm"
              @click=${this.clearError}
            >
              Dismiss
            </kanbrawl-button>
          </kanbrawl-banner>`
        : nothing}
      <kanbrawl-filter-bar
        .projects=${this.board.projects}
        .tasks=${this.board.tasks}
        .filter=${this.taskFilter}
        .hiddenCount=${hiddenTaskCount(this.taskFilter, this.board.tasks)}
        .unclassifiedCount=${unclassifiedTaskCount(this.board.tasks)}
        @toggle-all=${this.handleToggleAllProjects}
        @toggle-project=${this.handleToggleProjectFilter}
        @show-all=${this.handleShowAllProjects}
      ></kanbrawl-filter-bar>
      <main>
        <div class="board-area">
          <kanbrawl-board
            .columns=${this.board.columns}
            .tasks=${this.filteredTasks}
            .projects=${this.board.projects}
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
            <span>${this.notice.text}</span>
            ${this.notice.action
              ? html`<kanbrawl-button
                  class="banner-action"
                  variant="ghost"
                  size="sm"
                  @click=${() => {
                    const { action } = this.notice ?? {};
                    this.notice = undefined;
                    action?.();
                  }}
                >
                  ${this.notice.actionLabel ?? 'Open'}
                </kanbrawl-button>`
              : nothing}
            <kanbrawl-button
              class="banner-action"
              variant="ghost"
              size="sm"
              icon
              aria-label="Dismiss notification"
              @click=${() => {
                this.notice = undefined;
              }}
            >
              ✕
            </kanbrawl-button>
          </div>`
        : nothing}
      ${this.renderDetailDialog()} ${this.renderConfirmDialog()}
      ${this.renderViewer()}
    `;
  }
}
