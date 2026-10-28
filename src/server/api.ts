import { Router, type Response } from 'express';
import { BoardError } from './errors.js';
import type { BoardStore } from './store.js';
import type { Column } from './types.js';

const STATUS_BY_CODE: Record<string, number> = {
  TASK_NOT_FOUND: 404,
  COLUMN_NOT_FOUND: 404,
  DUPLICATE_COLUMN: 409,
  CONFLICT: 409,
  BOARD_LOCKED: 503,
  INVALID_BOARD_FILE: 500,
};

function sendError(res: Response, error: unknown): void {
  if (error instanceof BoardError) {
    const status = STATUS_BY_CODE[error.code] ?? 400;
    res.status(status).json({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({ error: message, code: 'INTERNAL_ERROR' });
}

function actorOf(request: {
  get: (name: string) => string | undefined;
}): string {
  const actor = request.get('x-kanbrawl-actor')?.trim() ?? '';
  return actor.length > 0 ? actor : 'human';
}

type TaskBody = {
  title?: string;
  description?: string;
  column?: string;
  priority?: string;
  assignee?: string;
  expectedUpdatedAt?: string;
  clientRequestId?: string;
  actor?: string;
};

function actorFrom(
  request: {
    get: (name: string) => string | undefined;
  },
  body: TaskBody,
): string {
  const actor = body.actor?.trim() ?? '';
  return actor.length > 0 ? actor : actorOf(request);
}

export function createApiRouter(store: BoardStore): Router {
  // eslint-disable-next-line new-cap
  const router = Router();

  // Get full board state
  router.get('/board', (_request, res) => {
    res.json(store.getBoard());
  });

  // Create a task
  router.post('/tasks', (request, res) => {
    try {
      const body = request.body as TaskBody;
      const task = store.createTask({
        title: body.title ?? '',
        description: body.description,
        column: body.column,
        priority: body.priority,
        assignee: body.assignee,
        clientRequestId: body.clientRequestId,
        actor: actorFrom(request, body),
      });
      res.status(201).json(task);
    } catch (error) {
      sendError(res, error);
    }
  });

  // Update a task (any combination of fields, including its column)
  router.patch('/tasks/:id', (request, res) => {
    try {
      const body = request.body as TaskBody;
      const task = store.updateTask(request.params.id, {
        title: body.title,
        description: body.description,
        column: body.column,
        priority: body.priority,
        assignee: body.assignee,
        expectedUpdatedAt: body.expectedUpdatedAt,
        actor: actorFrom(request, body),
      });
      res.json(task);
    } catch (error) {
      sendError(res, error);
    }
  });

  // Delete a task
  router.delete('/tasks/:id', (request, res) => {
    try {
      store.deleteTask(request.params.id);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  // Update columns
  router.put('/columns', (request, res) => {
    try {
      const { columns, moveTo } = request.body as {
        columns?: Column[];
        moveTo?: string;
      };
      if (!columns || !Array.isArray(columns)) {
        res.status(400).json({
          error: 'columns must be an array',
          code: 'INVALID_COLUMNS',
        });
        return;
      }

      const updated = store.updateColumns(columns, moveTo);
      res.json({ columns: updated });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
