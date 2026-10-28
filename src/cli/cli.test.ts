import { mkdtempSync, rmSync } from 'node:fs';
import process from 'node:process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoardStore } from '../server/store.js';
import { taskAction } from './commands/task.js';

// --- Task command tests ---
describe('task command', () => {
  let dir: string;
  let originalCwd: string;
  let stores: BoardStore[] = [];

  function openStore(): BoardStore {
    const store = new BoardStore(join(dir, 'kanbrawl.db'));
    stores.push(store);
    return store;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanbrawl-cli-test-'));
    originalCwd = process.cwd();
    stores = [];
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    for (const store of stores) {
      store.dispose();
    }

    rmSync(dir, { recursive: true, force: true });
  });

  it('creates a task with defaults', () => {
    taskAction('My task', { priority: '1' });
    const tasks = openStore().getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('My task');
    expect(tasks[0].priority).toBe('P1');
    expect(tasks[0].column).toBe('Todo');
  });

  it('creates a task with all options', () => {
    taskAction('Full task', {
      description: 'A description',
      column: 'In progress',
      priority: '0',
      assignee: 'alice',
    });
    const tasks = openStore().getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Full task');
    expect(tasks[0].description).toBe('A description');
    expect(tasks[0].column).toBe('In progress');
    expect(tasks[0].priority).toBe('P0');
    expect(tasks[0].assignee).toBe('alice');
  });

  it('updates an existing task with --update', () => {
    taskAction('Update me', { priority: '1' });
    taskAction('Update me', {
      update: true,
      description: 'Updated desc',
      priority: '2',
      assignee: 'bob',
    });
    const tasks = openStore().getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toBe('Updated desc');
    expect(tasks[0].priority).toBe('P2');
    expect(tasks[0].assignee).toBe('bob');
  });

  it('updates task column with --update --column', () => {
    taskAction('Move me', { priority: '1' });
    taskAction('Move me', {
      update: true,
      column: 'Done',
      priority: '1',
    });
    const tasks = openStore().getTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].column).toBe('Done');
  });

  it('sets exitCode when updating a non-existent task', () => {
    // Ensure kanbrawl.db exists
    openStore();
    const originalExitCode = process.exitCode;
    taskAction('Does not exist', { update: true, priority: '1' });
    expect(process.exitCode).toBe(1);
    process.exitCode = originalExitCode;
  });
});
