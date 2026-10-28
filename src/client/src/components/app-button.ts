import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'danger-outline'
  | 'plain';

export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * The app's button. Classic variants (primary, secondary, outline, ghost,
 * danger, danger-outline, plain) in three sizes, styled from the theme tokens
 * so it follows the active light/dark theme.
 *
 * Label and optional icon go in the default slot. `icon` makes a square
 * icon-only button, `block` stretches it to full width. One-off tuning is
 * done through the `button` CSS part, e.g. `.add-btn::part(button)`.
 *
 * `title` and `aria-label` on the host are forwarded to the inner button.
 * `type="submit"`/`type="reset"` bridge to the surrounding form because a
 * button inside a shadow root has no form owner.
 */
@customElement('kanbrawl-button')
export class KanbrawlButton extends LitElement {
  static override shadowRootOptions = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  @property({ reflect: true }) variant: ButtonVariant = 'primary';
  @property({ reflect: true }) size: ButtonSize = 'md';
  @property({ type: Boolean, reflect: true }) icon = false;
  @property({ type: Boolean, reflect: true }) block = false;
  @property({ type: Boolean, reflect: true }) disabled = false;
  @property({ reflect: true }) type: 'button' | 'submit' | 'reset' = 'button';

  static styles = css`
    :host {
      display: inline-flex;
      vertical-align: middle;
      font-family: 'DM Sans', 'Segoe UI', sans-serif;
    }

    .btn {
      display: inline-flex;
      flex: 1;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid transparent;
      border-radius: 6px;
      font: inherit;
      font-weight: 600;
      font-size: 12px;
      letter-spacing: 0.2px;
      line-height: 1;
      white-space: nowrap;
      cursor: pointer;
      user-select: none;
      transition:
        background 0.15s ease,
        color 0.15s ease,
        border-color 0.15s ease,
        box-shadow 0.15s ease,
        transform 0.1s ease;
    }

    .btn:active:not(:disabled) {
      transform: translateY(1px);
    }

    .btn:focus-visible {
      outline: 2px solid var(--accent, #ff6b35);
      outline-offset: 2px;
    }

    .btn:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    /* ── Sizes ── */
    .sm {
      min-height: 28px;
      padding: 4px 10px;
      font-size: 11px;
    }

    .md {
      min-height: 34px;
      padding: 6px 14px;
      font-size: 12px;
    }

    .lg {
      min-height: 42px;
      padding: 8px 18px;
      font-size: 13px;
      border-radius: 8px;
    }

    .icon {
      padding: 0;
    }

    .sm.icon {
      min-width: 28px;
    }

    .md.icon {
      min-width: 34px;
    }

    .lg.icon {
      min-width: 42px;
    }

    .block {
      display: flex;
      width: 100%;
    }

    :host([block]) {
      display: flex;
      width: 100%;
    }

    /* ── Variants ── */
    .primary {
      background: var(--accent-gradient, var(--accent, #ff6b35));
      color: var(--on-accent, #1b1109);
    }

    .primary:hover:not(:disabled) {
      background: var(--accent-hover, #ff8c61);
      box-shadow: 0 2px 12px var(--accent-glow, rgba(255, 107, 53, 0.4));
    }

    .secondary {
      background: var(--btn-secondary-bg, #22223a);
      color: var(--text-secondary, #b0b0cc);
    }

    .secondary:hover:not(:disabled) {
      background: var(--btn-secondary-hover, #30304e);
    }

    .outline {
      background: transparent;
      border-color: var(--border-input, #353550);
      color: var(--text-secondary, #b0b0cc);
    }

    .outline:hover:not(:disabled) {
      background: var(--accent-bg, rgba(255, 107, 53, 0.08));
      border-color: var(--accent, #ff6b35);
      color: var(--accent, #ff6b35);
    }

    .ghost {
      background: transparent;
      color: var(--text-muted, #9595b8);
    }

    .ghost:hover:not(:disabled) {
      background: var(--accent-bg, rgba(255, 107, 53, 0.08));
      color: var(--accent, #ff6b35);
    }

    .danger {
      background: var(--danger-solid-bg, #c0392b);
      color: var(--danger-solid-text, #ffffff);
    }

    .danger:hover:not(:disabled) {
      filter: brightness(1.1);
      box-shadow: 0 2px 12px rgba(192, 57, 43, 0.35);
    }

    .danger-outline {
      background: transparent;
      border-color: var(--border-input, #353550);
      color: var(--delete-text, #ff9a9a);
    }

    .danger-outline:hover:not(:disabled) {
      background: var(--delete-bg, #2d1216);
      border-color: var(--delete-text, #ff9a9a);
      color: var(--delete-text, #ff9a9a);
    }

    .plain {
      padding: 0;
      border: none;
      border-radius: 0;
      background: none;
      color: inherit;
      font: inherit;
      font-weight: inherit;
      letter-spacing: inherit;
      line-height: normal;
      white-space: normal;
      flex-direction: column;
      align-items: stretch;
      text-align: left;
    }

    .plain:hover:not(:disabled) {
      background: none;
      box-shadow: none;
      filter: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .btn {
        transition: none;
      }

      .btn:active:not(:disabled) {
        transform: none;
      }
    }
  `;

  render() {
    return html`
      <button
        part="button"
        class="btn ${this.variant} ${this.size}${this.icon ? ' icon' : ''}${this
          .block
          ? ' block'
          : ''}"
        type=${this.type}
        ?disabled=${this.disabled}
        title=${this.title || nothing}
        aria-label=${this.getAttribute('aria-label') ?? nothing}
        @click=${this.handleClick}
      >
        <slot></slot>
      </button>
    `;
  }

  // A button in a shadow tree has no form owner, so submit/reset need a bridge.
  private handleClick() {
    const form = this.closest('form');
    if (!form) return;
    if (this.type === 'submit') {
      form.requestSubmit();
    } else if (this.type === 'reset') {
      form.reset();
    }
  }
}
