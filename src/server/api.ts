import { Buffer } from 'node:buffer';
import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { LIMITS, type Column } from '../shared/board.js';
import { BoardError } from './errors.js';
import type { BoardStore } from './store.js';

const STATUS_BY_CODE: Record<string, number> = {
  TASK_NOT_FOUND: 404,
  COLUMN_NOT_FOUND: 404,
  ATTACHMENT_NOT_FOUND: 404,
  DUPLICATE_COLUMN: 409,
  CONFLICT: 409,
  ATTACHMENT_LIMIT: 409,
  ATTACHMENT_TOO_LARGE: 413,
  INVALID_ATTACHMENT: 415,
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

  // Upload an image. The bytes are the body; the declared Content-Type is
  // ignored because the image type is sniffed from the signature.
  router.post(
    '/tasks/:id/attachments',
    express.raw({
      type: () => true,
      limit: LIMITS.attachmentSize + 1024,
    }),
    (request, res) => {
      try {
        const { body } = request;
        if (!Buffer.isBuffer(body)) {
          res.status(415).json({
            error: 'Send the image bytes as the request body.',
            code: 'INVALID_ATTACHMENT',
          });
          return;
        }

        const filename =
          typeof request.query.filename === 'string'
            ? request.query.filename
            : undefined;
        const meta = store.addAttachment(request.params.id, {
          data: body,
          filename,
        });
        res.set('Content-Location', `/api/attachments/${meta.id}`);
        res.status(201).json(meta);
      } catch (error) {
        sendError(res, error);
      }
    },
  );

  router.get('/attachments/:id', (request, res) => {
    try {
      const attachment = store.getAttachment(request.params.id);
      if (!attachment) {
        throw new BoardError(
          'ATTACHMENT_NOT_FOUND',
          `Attachment with id "${request.params.id}" not found.`,
        );
      }

      const etag = `"${attachment.meta.sha256}"`;
      if (request.get('if-none-match') === etag) {
        res.status(304).end();
        return;
      }

      const { filename, mimeType } = attachment.meta;
      res.set({
        'Content-Type': mimeType,
        'Content-Length': String(attachment.data.length),
        ETag: etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(
          filename,
        ).replaceAll("'", '%27')}`,
      });
      res.send(Buffer.from(attachment.data));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.delete('/attachments/:id', (request, res) => {
    try {
      store.deleteAttachment(request.params.id);
      res.status(204).end();
    } catch (error) {
      sendError(res, error);
    }
  });

  router.use(
    (
      error: unknown,
      _request: Request,
      res: Response,
      next: NextFunction,
    ): void => {
      if ((error as { type?: string }).type === 'entity.too.large') {
        res.status(413).json({
          error: `Images must not exceed ${Math.floor(
            LIMITS.attachmentSize / 1024 / 1024,
          )} MB.`,
          code: 'ATTACHMENT_TOO_LARGE',
        });
        return;
      }

      next(error);
    },
  );

  return router;
}
