import process from 'node:process';
import { BoardError } from '../../server/errors.js';
import { BoardStore } from '../../server/store.js';

type TaskOptions = {
  description?: string;
  column?: string;
  priority?: string;
  assignee?: string;
  update?: boolean;
};

function fail(error: unknown): void {
  if (error instanceof BoardError) {
    console.error(`Error [${error.code}]: ${error.message}`);
  } else {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.exitCode = 1;
}

export function taskAction(title: string, options: TaskOptions): void {
  const store = new BoardStore();
  const priority = options.priority
    ? (`P${options.priority}` as const)
    : undefined;

  try {
    if (options.update) {
      const tasks = store.getTasks();
      const existing = tasks.find(
        (t) => t.title.toLowerCase() === title.toLowerCase(),
      );

      if (!existing) {
        console.error(`Error: No task found with title "${title}"`);
        process.exitCode = 1;
        return;
      }

      const updated = store.updateTask(existing.id, {
        description: options.description,
        priority,
        assignee: options.assignee,
        column: options.column,
        actor: 'cli',
      });

      console.log(`✅ Task updated: ${updated.title} (${updated.id})`);
    } else {
      const task = store.createTask({
        title,
        description: options.description,
        column: options.column,
        priority,
        assignee: options.assignee,
        actor: 'cli',
      });
      console.log(`✅ Task created: ${task.title} (${task.id})`);
    }
  } catch (error) {
    fail(error);
  } finally {
    store.dispose();
  }
}
