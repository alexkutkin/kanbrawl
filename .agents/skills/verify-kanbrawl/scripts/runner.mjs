// Playwright scenarios for Kanbrawl. This file is copied into the running
// `playwright-sandbox-1` container and executed there, so no browser window
// ever opens on the host desktop.
//
// Inputs (environment):
//   KB_BASE_URL  board URL reachable from inside the container
//   KB_FEATURE   scenario id: board | tasks | drag-drop | task-detail | columns
//   KB_OUT       evidence directory inside the container
//   KB_PW_ROOT   directory whose node_modules contains `playwright` (default /app)
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.KB_BASE_URL;
const FEATURE = process.env.KB_FEATURE;
const OUT = process.env.KB_OUT;
const MODULE_ROOT = process.env.KB_PW_ROOT ?? '/app';

if (!BASE_URL || !FEATURE || !OUT) {
  console.error('KB_BASE_URL, KB_FEATURE and KB_OUT are required');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const require = createRequire(join(MODULE_ROOT, 'package.json'));
const { chromium } = require('playwright');

const DEFAULT_COLUMNS = [
  { name: 'Todo', sortBy: 'priority', sortOrder: 'asc' },
  { name: 'In progress', sortBy: 'created', sortOrder: 'asc' },
  { name: 'Blocked', sortBy: 'created', sortOrder: 'asc' },
  { name: 'Done', sortBy: 'updated', sortOrder: 'desc' },
];

const steps = [];
const shots = [];
let page;
let shotIndex = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function check(name, fn) {
  const started = Date.now();
  console.log(`- ${name}`);
  try {
    await fn();
    steps.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ok (${Date.now() - started}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ name, ok: false, ms: Date.now() - started, error: message });
    console.log(`  ✖ ${message}`);
    try {
      const failureShot = `failure-${String(shotIndex).padStart(2, '0')}.png`;
      await page?.screenshot({ path: join(OUT, failureShot), fullPage: true });
      shots.push(failureShot);
    } catch {}

    throw error;
  }
}

async function shot(name) {
  const file = `${String(shotIndex++).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(OUT, file), fullPage: true });
  shots.push(file);
  console.log(`  📸 ${file}`);
}

async function waitFor(fn, { timeout = 10_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, interval);
    });
  }

  throw new Error(
    `timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  }

  return response.status === 204 ? undefined : response.json();
}

async function resetBoard() {
  const board = await api('GET', '/api/board');
  for (const task of board.tasks) {
    await api('DELETE', `/api/tasks/${task.id}`);
  }

  await api('PUT', '/api/columns', { columns: DEFAULT_COLUMNS });
  const fresh = await api('GET', '/api/board');
  assert(fresh.tasks.length === 0, 'board reset left tasks behind');
  assert(fresh.columns.length === DEFAULT_COLUMNS.length, 'board reset did not restore default columns');
  return fresh;
}

async function findTaskByTitle(title) {
  const board = await api('GET', '/api/board');
  return board.tasks.find((task) => task.title === title);
}

async function columnNames() {
  return page
    .locator('kanbrawl-column')
    .evaluateAll((nodes) => nodes.map((node) => node.name));
}

async function columnIndex(name) {
  return page
    .locator('kanbrawl-column')
    .evaluateAll(
      (nodes, columnName) => nodes.findIndex((node) => node.name === columnName),
      name,
    );
}

async function column(name) {
  const index = await columnIndex(name);
  assert(index >= 0, `column "${name}" is not rendered`);
  return page.locator('kanbrawl-column').nth(index);
}

async function taskIndex(title) {
  return page
    .locator('kanbrawl-task')
    .evaluateAll(
      (nodes, taskTitle) => nodes.findIndex((node) => node.task?.title === taskTitle),
      title,
    );
}

async function task(title) {
  const index = await taskIndex(title);
  assert(index >= 0, `task "${title}" is not rendered`);
  return page.locator('kanbrawl-task').nth(index);
}

async function waitForTask(title) {
  await waitFor(async () => (await taskIndex(title)) >= 0, {
    label: `task "${title}" to render`,
  });
  await (await task(title)).waitFor({ state: 'visible' });
}

async function tasksIn(columnName) {
  const index = await columnIndex(columnName);
  if (index < 0) return [];
  return page
    .locator('kanbrawl-column')
    .nth(index)
    .locator('kanbrawl-task .task-title')
    .allInnerTexts();
}

async function openBoard() {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('.status-dot.online').waitFor({ timeout: 10_000 });
}

async function confirmDelete() {
  const dialog = page.locator('dialog.confirm');
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('.btn-danger').click();
}

function stamp() {
  return Date.now().toString(36);
}

async function scenarioBoard() {
  await check('live connection is established', async () => {
    await openBoard();
  });

  await check('default columns render from the board file', async () => {
    const names = await columnNames();
    assertEqual(
      names.join('|'),
      DEFAULT_COLUMNS.map((item) => item.name).join('|'),
      'rendered columns',
    );
  });

  await check('an empty board shows the empty state in every column', async () => {
    const count = await page.locator('kanbrawl-column .empty-state').count();
    assertEqual(count, DEFAULT_COLUMNS.length, 'empty-state blocks');
  });

  await shot('empty-board');

  const title = `verify-live-${stamp()}`;
  await check('a task created through the REST API appears live, without reload', async () => {
    await api('POST', '/api/tasks', {
      title,
      description: 'Created by the verifier through the API',
      column: 'Todo',
      priority: 'P0',
      assignee: 'verify-agent',
    });
    await waitForTask(title);
    const card = await task(title);
    assertEqual(await card.locator('.priority-badge').innerText(), 'P0', 'priority badge');
    assertEqual(await card.locator('.task-assignee').innerText(), 'verify-agent', 'assignee chip');
  });

  await check('Todo renders the live task', async () => {
    assert((await tasksIn('Todo')).includes(title), 'task is not rendered inside Todo');
  });

  await shot('live-create');

  await check('moving the task through the API moves the card live', async () => {
    const stored = await findTaskByTitle(title);
    assert(stored, 'created task is missing from the API');
    await api('PATCH', `/api/tasks/${stored.id}`, { column: 'In progress' });
    await waitFor(async () => (await tasksIn('In progress')).includes(title), {
      label: `"${title}" to appear in In progress`,
    });
    assert(!(await tasksIn('Todo')).includes(title), 'task is still rendered in Todo');
    const moved = await findTaskByTitle(title);
    assertEqual(moved.column, 'In progress', 'stored column');
  });

  await shot('live-move');
}

async function scenarioTasks() {
  await openBoard();
  const title = `verify-ui-${stamp()}`;
  const editedTitle = `${title} edited`;

  await check('create a task from the Todo column in the dialog', async () => {
    const todo = await column('Todo');
    await todo.locator('.add-btn').click();
    const dialog = page.locator('dialog.task-detail');
    await dialog.waitFor({ state: 'visible' });
    const form = dialog.locator('.detail-edit-form');
    await form.locator('input[placeholder="Task title"]').fill(title);
    await form.locator('textarea').fill('Drafted in the web UI');
    await form.locator('select').selectOption('P0');
    await form.locator('input[placeholder="Name (optional)"]').fill('human-verifier');
    await shot('create-dialog');
    await form.locator('button[type="submit"]').click();

    await waitFor(async () => !(await dialog.evaluate((node) => node.open)), {
      label: 'create dialog to close',
    });
    await waitForTask(title);
    const card = await task(title);
    assertEqual(await card.locator('.priority-badge').innerText(), 'P0', 'priority badge');
    assertEqual(await card.locator('.task-assignee').innerText(), 'human-verifier', 'assignee chip');
    assert(
      (await card.locator('.task-description').innerText()).includes('Drafted in the web UI'),
      'card does not show the description',
    );

    const stored = await findTaskByTitle(title);
    assert(stored, 'created task is missing from the API');
    assertEqual(stored.priority, 'P0', 'stored priority');
    assertEqual(stored.assignee, 'human-verifier', 'stored assignee');
    assertEqual(stored.description, 'Drafted in the web UI', 'stored description');
    assertEqual(stored.column, 'Todo', 'stored column');
  });

  await shot('created-via-ui');

  await check('edit title, priority and assignee in the dialog', async () => {
    const card = await task(title);
    await card.hover();
    await card.locator('button[title="Edit"]').click();
    const dialog = page.locator('dialog.task-detail');
    await dialog.waitFor({ state: 'visible' });
    const form = dialog.locator('.detail-edit-form');
    await form.locator('input[placeholder="Task title"]').fill(editedTitle);
    await form.locator('textarea').fill('Edited in the web UI');
    await form.locator('select').selectOption('P2');
    await form.locator('input[placeholder="Name (optional)"]').fill('robot-editor');
    await shot('edit-dialog');
    await form.locator('button[type="submit"]').click();

    await waitFor(
      async () => (await dialog.locator('.detail-task-title').innerText()) === editedTitle,
      { label: 'dialog to show the saved title' },
    );
    await page.keyboard.press('Escape');
    await waitFor(async () => !(await dialog.evaluate((node) => node.open)), {
      label: 'edit dialog to close',
    });

    await waitForTask(editedTitle);
    const editedCard = await task(editedTitle);
    assertEqual(await editedCard.locator('.priority-badge').innerText(), 'P2', 'priority badge');
    assertEqual(await editedCard.locator('.task-assignee').innerText(), 'robot-editor', 'assignee chip');

    const stored = await findTaskByTitle(editedTitle);
    assert(stored, 'edited task is missing from the API');
    assertEqual(stored.priority, 'P2', 'stored priority');
    assertEqual(stored.assignee, 'robot-editor', 'stored assignee');
    assertEqual(stored.description, 'Edited in the web UI', 'stored description');
  });

  await shot('edited-via-ui');

  await check('delete the task from the card actions', async () => {
    const card = await task(editedTitle);
    await card.hover();
    await card.locator('button[title="Delete"]').click();
    await confirmDelete();
    await waitFor(async () => (await findTaskByTitle(editedTitle)) === undefined, {
      label: 'task to disappear from the API',
    });
    await waitFor(async () => !(await tasksIn('Todo')).includes(editedTitle), {
      label: 'card to disappear from Todo',
    });
    assert((await findTaskByTitle(editedTitle)) === undefined, 'task is still in the API');
  });

  await shot('deleted-via-ui');
}

async function scenarioDragDrop() {
  await openBoard();
  const title = `verify-drag-${stamp()}`;
  await api('POST', '/api/tasks', { title, column: 'Todo', priority: 'P1' });
  await waitForTask(title);

  await check('drag the card from Todo to Done', async () => {
    const card = await task(title);
    const done = await column('Done');
    await card.dragTo(done);
    await waitFor(async () => (await tasksIn('Done')).includes(title), {
      label: `"${title}" to appear in Done`,
    });
    assert(!(await tasksIn('Todo')).includes(title), 'card is still in Todo');
    const stored = await findTaskByTitle(title);
    assert(stored, 'dragged task is missing from the API');
    assertEqual(stored.column, 'Done', 'stored column');
  });

  await shot('after-drag');

  await check('the drop target is no longer highlighted', async () => {
    const done = await column('Done');
    const classes = await done.getAttribute('class');
    assert(!(classes ?? '').includes('drag-over'), 'Done still has drag-over class');
  });
}

async function scenarioTaskDetail() {
  await openBoard();
  const title = `verify-detail-${stamp()}`;
  const description = 'Line one of the report.\nLine two with more detail.';
  await api('POST', '/api/tasks', {
    title,
    description,
    column: 'In progress',
    priority: 'P0',
    assignee: 'detail-agent',
  });
  await waitForTask(title);

  await check('clicking a card opens the task detail dialog', async () => {
    const card = await task(title);
    await card.locator('.task-card').click();
    const dialog = page.locator('dialog.task-detail');
    await dialog.waitFor({ state: 'visible' });
    assert(await dialog.evaluate((element) => element.open), 'dialog is not open');

    assertEqual(await dialog.locator('.detail-task-title').innerText(), title, 'dialog title');
    assertEqual(
      (await dialog.locator('.detail-description').innerText()).trim(),
      description,
      'dialog description',
    );
    assertEqual(await dialog.locator('.detail-badge.priority-P0').innerText(), 'P0', 'priority badge');
    assertEqual(await dialog.locator('.detail-badge.column').innerText(), 'In progress', 'column badge');
    assertEqual(
      await dialog.locator('.detail-meta dd').first().innerText(),
      'detail-agent',
      'assignee metadata',
    );
  });

  await shot('detail-dialog');

  await check('Escape closes the dialog and keeps the task', async () => {
    await page.keyboard.press('Escape');
    await waitFor(
      async () => (await page.locator('dialog.task-detail[open]').count()) === 0,
      { label: 'dialog to close' },
    );
    assert(await findTaskByTitle(title), 'task was removed when the dialog closed');
    assert((await tasksIn('In progress')).includes(title), 'card disappeared from the board');
  });

  await check('the close button dismisses the dialog', async () => {
    const card = await task(title);
    await card.locator('.task-card').click();
    const dialog = page.locator('dialog.task-detail[open]');
    await dialog.waitFor({ state: 'visible' });
    await page.locator('dialog.task-detail button[aria-label="Close task details"]').click();
    await waitFor(
      async () => (await page.locator('dialog.task-detail[open]').count()) === 0,
      { label: 'dialog to close from its button' },
    );
  });
}

async function scenarioColumns() {
  await openBoard();
  const lowTitle = `verify-sort-low-${stamp()}`;
  const criticalTitle = `verify-sort-critical-${stamp()}`;
  await api('POST', '/api/tasks', { title: lowTitle, column: 'Todo', priority: 'P2' });
  await api('POST', '/api/tasks', { title: criticalTitle, column: 'Todo', priority: 'P0' });
  await waitForTask(lowTitle);
  await waitForTask(criticalTitle);

  await check('rename Blocked, add Review, sort Todo descending, then save', async () => {
    await page.locator('kanbrawl-column-settings .settings-btn').click();
    const modal = page.locator('.modal');
    await modal.waitFor({ state: 'visible' });

    const inputs = modal.locator('.column-row input');
    assertEqual(await inputs.count(), DEFAULT_COLUMNS.length, 'column name inputs');
    await inputs.nth(2).fill('On hold');

    await modal.locator('.add-column-btn').click();
    await waitFor(async () => (await inputs.count()) === DEFAULT_COLUMNS.length + 1, {
      label: 'a new column row to appear',
    });
    await inputs.nth(DEFAULT_COLUMNS.length).fill('Review');
    await modal
      .locator('.column-row')
      .nth(DEFAULT_COLUMNS.length)
      .locator('button[title="Move up"]')
      .click();

    const todoSort = modal.locator('.sort-row').nth(0).locator('select');
    await todoSort.nth(0).selectOption('priority');
    await todoSort.nth(1).selectOption('desc');

    await modal.locator('.btn-save').click();
    await waitFor(
      async () => (await columnNames()).join('|') === 'Todo|In progress|On hold|Review|Done',
      { label: 'the board to show the new columns' },
    );
  });

  await shot('columns-updated');

  await check('board and API persist the new columns and sort order', async () => {
    const board = await api('GET', '/api/board');
    assertEqual(
      board.columns.map((item) => item.name).join('|'),
      'Todo|In progress|On hold|Review|Done',
      'API columns',
    );
    assertEqual(board.columns[0].sortBy, 'priority', 'Todo sort field');
    assertEqual(board.columns[0].sortOrder, 'desc', 'Todo sort order');

    const order = await tasksIn('Todo');
    assertEqual(order[0], lowTitle, 'first Todo card after descending priority sort');
    assertEqual(order[1], criticalTitle, 'second Todo card after descending priority sort');
  });
}

const scenarios = {
  board: scenarioBoard,
  tasks: scenarioTasks,
  'drag-drop': scenarioDragDrop,
  'task-detail': scenarioTaskDetail,
  columns: scenarioColumns,
};

const scenario = scenarios[FEATURE];
if (!scenario) {
  console.error(`Unknown feature "${FEATURE}". Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}

const startedAt = new Date().toISOString();
let failure;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  page = await context.newPage();
  await resetBoard();
  await scenario();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  const board = await api('GET', '/api/board').catch(() => undefined);
  const report = {
    feature: FEATURE,
    baseUrl: BASE_URL,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok: !failure,
    failure,
    steps,
    shots,
    finalBoard: board,
  };
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = steps.filter((step) => !step.ok).length;
  console.log(
    `${failure ? '✖' : '✔'} ${FEATURE}: ${steps.length - failed}/${steps.length} checks passed, ${shots.length} screenshots`,
  );
  if (failure) console.log(`  ${failure}`);
  await browser.close();
}

process.exit(failure ? 1 : 0);
