import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type BadgeTone = 'P0' | 'P1' | 'P2' | 'neutral' | 'stale';
export type BadgeSize = 'sm' | 'md';

/**
 * The app's pill badge: task priorities (P0/P1/P2), a neutral chip for
 * columns, and the stale marker. Styled from the theme tokens; the label
 * goes in the default slot. `sm` is the card scale, `md` the dialog scale.
 */
@customElement('kanbrawl-badge')
export class KanbrawlBadge extends LitElement {
  @property({ reflect: true }) tone: BadgeTone = 'neutral';
  @property({ reflect: true }) size: BadgeSize = 'md';

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      font-family: 'Space Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.5px;
      line-height: 1.4;
      border-radius: 4px;
      white-space: nowrap;
    }

    /* ── Sizes ── */
    :host([size='sm']) {
      padding: 2px 6px;
    }

    :host([size='md']) {
      padding: 3px 10px;
    }

    /* ── Tones ── */
    :host([tone='P0']) {
      background: var(--priority-p0-bg, rgba(239, 68, 68, 0.15));
      color: var(--priority-p0-text, #ff8585);
    }

    :host([tone='P1']) {
      background: var(--priority-p1-bg, rgba(245, 158, 11, 0.15));
      color: var(--priority-p1-text, #fbbf24);
    }

    :host([tone='P2']) {
      background: var(--priority-p2-bg, rgba(107, 114, 128, 0.18));
      color: var(--priority-p2-text, #a9b0bd);
    }

    :host([tone='neutral']) {
      background: var(--count-bg, rgba(120, 120, 160, 0.12));
      color: var(--text-secondary, #b0b0cc);
    }

    :host([tone='stale']) {
      background: var(--stale-bg, rgba(245, 158, 11, 0.12));
      color: var(--stale-text, #b45309);
      text-transform: uppercase;
    }

    :host([tone='stale'][size='sm']) {
      font-size: 10px;
    }
  `;

  render() {
    return html`<slot></slot>`;
  }
}
