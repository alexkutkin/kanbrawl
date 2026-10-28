import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type BannerTone = 'warning' | 'error';

/**
 * The app's message strip pinned under the header: a warning banner for the
 * stale-connection notice and an error banner for failed operations. The
 * message goes in the default slot, action buttons in the `actions` slot.
 */
@customElement('kanbrawl-banner')
export class KanbrawlBanner extends LitElement {
  @property({ reflect: true }) tone: BannerTone = 'warning';

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--border-input, #353550);
      font-size: 12px;
      flex-shrink: 0;
    }

    :host([tone='warning']) {
      background: var(--stale-bg, rgba(245, 158, 11, 0.12));
      color: var(--stale-text, #b45309);
    }

    :host([tone='error']) {
      background: var(--error-bg, #2d1216);
      border-bottom-color: var(--error-border, #5c2028);
      color: var(--error-text, #ff9a9a);
      font-size: 13px;
    }

    .message {
      flex: 1;
      min-width: 0;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }
  `;

  render() {
    return html`
      <span class="message"><slot></slot></span>
      <span class="actions"><slot name="actions"></slot></span>
    `;
  }
}
