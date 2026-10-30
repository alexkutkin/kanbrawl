// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import type { Project } from '../../../shared/board.js';
import type { TaskFilter } from '../task-filter.js';
import { KanbrawlFilterBar } from './filter-bar.js';

const PROJECTS: Project[] = [
  { id: 'p1', name: 'Kanbrawl', folder: 'C:/work/kanbrawl' },
  { id: 'p2', name: 'Tooling', folder: 'C:/work/tooling' },
];

async function mount(properties: {
  filter: TaskFilter;
  hiddenCount?: number;
  unclassifiedCount?: number;
}): Promise<KanbrawlFilterBar> {
  const bar = document.createElement('kanbrawl-filter-bar');
  bar.projects = PROJECTS;
  bar.filter = properties.filter;
  bar.hiddenCount = properties.hiddenCount ?? 0;
  bar.unclassifiedCount = properties.unclassifiedCount ?? 0;
  document.body.append(bar);
  await bar.updateComplete;
  return bar;
}

function chips(bar: KanbrawlFilterBar): HTMLButtonElement[] {
  return [
    ...bar.shadowRoot!.querySelectorAll<HTMLButtonElement>('.chips .chip'),
  ];
}

describe('kanbrawl-filter-bar', () => {
  it('renders one pressed chip per project in all mode', async () => {
    const bar = await mount({ filter: { mode: 'all' } });
    expect(bar).toBeInstanceOf(KanbrawlFilterBar);
    const buttons = chips(bar);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Kanbrawl',
      'Tooling',
    ]);
    expect(
      buttons.every((button) => button.getAttribute('aria-pressed') === 'true'),
    ).toBe(true);
    expect(bar.shadowRoot!.textContent).not.toContain('hidden');
  });

  it('emits toggle-project with the project id and shows off chips', async () => {
    const bar = await mount({
      filter: { mode: 'selected', ids: ['p1'] },
      hiddenCount: 3,
      unclassifiedCount: 1,
    });
    const events: Array<{ name: string; detail?: string }> = [];
    bar.addEventListener('toggle-project', (event) => {
      events.push({
        name: 'toggle-project',
        detail: (event as CustomEvent<string>).detail,
      });
    });

    const buttons = chips(bar);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');

    buttons[1].click();
    expect(events).toEqual([{ name: 'toggle-project', detail: 'p2' }]);

    const status = bar.shadowRoot!.querySelector('.filter-status')!;
    expect(status.textContent).toContain('3 hidden');
    expect(status.textContent).toContain('1 without a project');
  });

  it('emits toggle-all from the master control', async () => {
    const bar = await mount({ filter: { mode: 'all' } });
    const events: string[] = [];
    bar.addEventListener('toggle-all', () => {
      events.push('toggle-all');
    });

    bar.shadowRoot!.querySelector<HTMLButtonElement>('.is-master')!.click();
    expect(events).toEqual(['toggle-all']);
  });

  it('shows the empty state with a Show all action when nothing is selected', async () => {
    const bar = await mount({ filter: { mode: 'selected', ids: [] } });
    const empty = bar.shadowRoot!.querySelector('.filter-empty')!;
    expect(empty.textContent).toContain('Every project is switched off');

    const events: string[] = [];
    bar.addEventListener('show-all', () => {
      events.push('show-all');
    });
    empty.querySelector<HTMLButtonElement>('.empty-action')!.click();
    expect(events).toEqual(['show-all']);
  });

  it('hides the empty state when at least one project is selected', async () => {
    const bar = await mount({ filter: { mode: 'selected', ids: ['p1'] } });
    expect(bar.shadowRoot!.querySelector('.filter-empty')).toBeNull();
  });
});
