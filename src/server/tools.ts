import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { LIMITS, type AttachmentMeta, type Task } from '../shared/board.js';
import { BoardError } from './errors.js';
import type { BoardStore } from './store.js';

const attachmentSchema = z.object({
  id: z.string().describe('Attachment ID (UUID)'),
  taskId: z.string().describe('Task the image belongs to'),
  filename: z.string(),
  mimeType: z.string().describe('Sniffed image type (png, jpeg, gif, webp)'),
  size: z.number().describe('Image size in bytes'),
  sha256: z.string().describe('Content hash of the image bytes'),
  createdAt: z.string(),
});

const projectSchema = z.object({
  id: z.string().describe('Stable project ID (UUID), survives renames'),
  name: z.string().describe('Unique project name'),
  folder: z
    .string()
    .describe(
      'Path of the project code folder; stored as metadata and never validated against the filesystem',
    ),
});

const publicTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  column: z.string().describe('Name of the column the task is in'),
  priority: z
    .enum(['P0', 'P1', 'P2'])
    .describe('P0 = urgent/critical, P1 = normal (default), P2 = low priority'),
  assignee: z.string(),
  projectId: z
    .string()
    .optional()
    .describe(
      'ID of the project the task belongs to (see get_projects); absent only for tasks predating the project catalog',
    ),
  lastActor: z
    .string()
    .describe('Who last changed the task (agent name, "human", or empty)'),
  createdAt: z.string(),
  updatedAt: z.string(),
  attachments: z
    .array(attachmentSchema)
    .describe('Images attached to the task; fetch bytes with get_attachment'),
});

const taskOutputSchema = publicTaskSchema.shape;

function toPublicTask(task: Task): z.infer<typeof publicTaskSchema> {
  const { clientRequestId: _clientRequestId, ...rest } = task;
  return rest;
}

const prioritySchema = z
  .enum(['P0', 'P1', 'P2'])
  .describe('P0 = urgent/critical, P1 = normal (default), P2 = low priority');

const actorSchema = z
  .string()
  .max(LIMITS.assignee)
  .optional()
  .describe(
    'Name recorded as the last actor for this change. Defaults to the assignee or "agent".',
  );

const expectedUpdatedAtSchema = z
  .string()
  .optional()
  .describe(
    'Optimistic concurrency guard: the task updatedAt value you last saw. The call fails with CONFLICT if the task changed since.',
  );

const projectIdSchema = z
  .string()
  .nullable()
  .optional()
  .describe(
    'ID of the project the task belongs to (required; see get_projects). Omit on updates to keep the current project; an explicit null is rejected with INVALID_PROJECT.',
  );

function toolError(error: unknown): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  if (error instanceof BoardError) {
    const details = error.details ? ` ${JSON.stringify(error.details)}` : '';
    return {
      content: [
        {
          type: 'text',
          text: `Error [${error.code}]: ${error.message}${details}`,
        },
      ],
      isError: true,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: `Error [INTERNAL_ERROR]: ${message}` }],
    isError: true,
  };
}

function ok<T extends Record<string, unknown>>(payload: T) {
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

export function registerTools(server: McpServer, store: BoardStore): void {
  server.registerTool(
    'get_columns',
    {
      title: 'Get Columns',
      description:
        'Get the current board columns with their IDs, task counts and sorting. Call this before creating or moving a task when you do not know the exact column names.',
      inputSchema: {},
      outputSchema: {
        columns: z.array(
          z.object({
            id: z.string().describe('Stable column ID, survives renames'),
            name: z.string().describe('Current column name'),
            taskCount: z.number().describe('Number of tasks in the column'),
            sortBy: z
              .enum(['priority', 'created', 'updated'])
              .describe('Sort field for tasks in this column'),
            sortOrder: z
              .enum(['asc', 'desc'])
              .describe('Sort order for tasks in this column'),
          }),
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const allTasks = store.getTasks();
      const columnsWithCounts = store.getColumns().map((col) => ({
        id: col.id,
        name: col.name,
        taskCount: allTasks.filter((t) => t.column === col.name).length,
        sortBy: col.sortBy,
        sortOrder: col.sortOrder,
      }));
      return ok({ columns: columnsWithCounts });
    },
  );

  server.registerTool(
    'get_projects',
    {
      title: 'Get Projects',
      description:
        'Get the board project catalog: stable IDs, names, folder paths and the catalog revision. The list order is the display order.',
      inputSchema: {},
      outputSchema: {
        projects: z.array(projectSchema),
        revision: z
          .number()
          .describe('Catalog revision; increments on every accepted change'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      ok({
        projects: store.getProjects(),
        revision: store.getProjectsRevision(),
      }),
  );

  server.registerTool(
    'update_projects',
    {
      title: 'Update Projects',
      description:
        'Replace the full project list in one atomic change: entries matching an existing project by id (or name) are kept, renamed and reordered, new entries are created, and projects missing from the list are deleted (refused with PROJECT_NOT_EMPTY while they still hold tasks). Pass expectedRevision to fail with CONFLICT instead of overwriting concurrent changes; without it the write is last-write-wins. The revision increments on every accepted change regardless of writer.',
      inputSchema: {
        projects: z
          .array(
            z.object({
              id: z
                .string()
                .optional()
                .describe(
                  'ID of an existing project to keep; omit to create a new project',
                ),
              name: z.string().describe('Unique project name'),
              folder: z
                .string()
                .describe(
                  'Path of the project code folder; stored as metadata and never validated against the filesystem',
                ),
            }),
          )
          .describe('The complete new project list in display order'),
        expectedRevision: z
          .number()
          .int()
          .optional()
          .describe(
            'Optimistic concurrency guard: the catalog revision you last saw. The call fails with CONFLICT if the list changed since. Omit for last-write-wins.',
          ),
      },
      outputSchema: {
        projects: z.array(projectSchema),
        revision: z.number().describe('New catalog revision'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projects, expectedRevision }) => {
      try {
        return ok(store.updateProjects(projects, expectedRevision));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_task',
    {
      title: 'Get Task',
      description:
        'Get a single task by its ID, including its full description and history metadata.',
      inputSchema: {
        id: z.string().describe('Task ID (UUID)'),
      },
      outputSchema: taskOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      const task = store.getTask(id);
      if (!task) {
        return toolError(
          new BoardError('TASK_NOT_FOUND', `Task with id "${id}" not found.`),
        );
      }

      return ok({ ...toPublicTask(task) });
    },
  );

  server.registerTool(
    'list_tasks',
    {
      title: 'List Tasks',
      description:
        'List tasks on the board across all columns (or one column), optionally filtered by priority and assignee. Results are sorted by priority (P0 first) then oldest first. The response reports total and hasMore, so nothing is hidden silently.',
      inputSchema: {
        column: z
          .string()
          .optional()
          .describe(
            'Column name to filter by. Omit to list tasks from every column. Call get_columns for current names.',
          ),
        projectIds: z
          .array(z.string())
          .optional()
          .describe(
            'Project IDs to filter by (union). Omit to list tasks from every project. An empty array is rejected with INVALID_PROJECT and an unknown id with PROJECT_NOT_FOUND. Call get_projects for current ids.',
          ),
        priority: prioritySchema.optional(),
        assignee: z
          .string()
          .optional()
          .describe('Filter tasks by assignee name (case-insensitive match)'),
        max: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe('Maximum number of tasks to return (default: 100)'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Number of matching tasks to skip (default: 0)'),
      },
      outputSchema: {
        tasks: z.array(publicTaskSchema),
        total: z
          .number()
          .describe('Number of tasks matching the filters before pagination'),
        hasMore: z
          .boolean()
          .describe('Whether more matching tasks exist after this page'),
        offset: z.number().describe('Offset used for this page'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ column, projectIds, priority, assignee, max, offset }) => {
      const columnNames = store.getColumnNames();
      if (column !== undefined && !columnNames.includes(column.trim())) {
        return toolError(
          new BoardError(
            'COLUMN_NOT_FOUND',
            `Column "${column}" does not exist.`,
            { availableColumns: columnNames },
          ),
        );
      }

      if (projectIds !== undefined) {
        if (projectIds.length === 0) {
          return toolError(
            new BoardError(
              'INVALID_PROJECT',
              'projectIds must not be empty; omit it to list tasks from every project.',
            ),
          );
        }

        const known = store.getProjects().map((project) => project.id);
        const unknown = projectIds.filter((id) => !known.includes(id));
        if (unknown.length > 0) {
          return toolError(
            new BoardError(
              'PROJECT_NOT_FOUND',
              `Project with id "${unknown[0]}" does not exist. Available projects: ${known.join(', ')}`,
              { availableProjects: known },
            ),
          );
        }
      }

      let tasks = store.getTasks(column?.trim());
      if (projectIds !== undefined) {
        const selected = new Set(projectIds);
        tasks = tasks.filter(
          (task) =>
            typeof task.projectId === 'string' && selected.has(task.projectId),
        );
      }

      if (priority) {
        tasks = tasks.filter((t) => t.priority === priority);
      }

      if (assignee) {
        const lowerAssignee = assignee.toLowerCase();
        tasks = tasks.filter((t) => t.assignee.toLowerCase() === lowerAssignee);
      }

      const columnOrder = new Map(
        store.getColumns().map((item, index) => [item.name, index]),
      );
      tasks.sort((a, b) => {
        const priorityCompare = a.priority.localeCompare(b.priority);
        if (priorityCompare !== 0) return priorityCompare;
        const byColumn =
          (columnOrder.get(a.column) ?? 0) - (columnOrder.get(b.column) ?? 0);
        if (!column && byColumn !== 0) return byColumn;
        return a.createdAt.localeCompare(b.createdAt);
      });

      const total = tasks.length;
      const start = offset ?? 0;
      const limit = max ?? 100;
      const page = tasks.slice(start, start + limit);
      return ok({
        tasks: page.map((task) => toPublicTask(task)),
        total,
        hasMore: start + page.length < total,
        offset: start,
      });
    },
  );

  server.registerTool(
    'create_task',
    {
      title: 'Create Task',
      description:
        'Create a new task on the board. Every task belongs to exactly one project: pass projectId (call get_projects for current ids). Call get_columns first if you do not know the column names. Pass clientRequestId to make a retry safe: repeating the same key returns the already created task instead of a duplicate.',
      inputSchema: {
        title: z
          .string()
          .min(1, 'Title is required')
          .max(LIMITS.title, `Title must not exceed ${LIMITS.title} characters`)
          .describe('Task title'),
        description: z
          .string()
          .max(
            LIMITS.description,
            `Description must not exceed ${LIMITS.description} characters`,
          )
          .optional()
          .describe('Task description'),
        column: z
          .string()
          .optional()
          .describe(
            'Column to place the task in. Defaults to the first board column. Call get_columns for current names.',
          ),
        projectId: projectIdSchema,
        priority: prioritySchema.optional(),
        assignee: z
          .string()
          .max(LIMITS.assignee)
          .optional()
          .describe('Name of the person or agent assigned to this task'),
        actor: actorSchema,
        clientRequestId: z
          .string()
          .max(200)
          .optional()
          .describe(
            'Idempotency key. Repeating a call with the same key returns the task created by the first call.',
          ),
      },
      outputSchema: taskOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      title,
      description,
      column,
      projectId,
      priority,
      assignee,
      actor,
      clientRequestId,
    }) => {
      // An explicit null is a caller error: only a string may reach the store.
      if (projectId === null) {
        return toolError(
          new BoardError(
            'INVALID_PROJECT',
            'projectId must be a project id string.',
          ),
        );
      }

      try {
        const task = store.createTask({
          title,
          description,
          column,
          projectId,
          priority,
          assignee,
          actor,
          clientRequestId,
        });
        return ok({ ...toPublicTask(task) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'move_task',
    {
      title: 'Move Task',
      description:
        "Move a task to another column. Use expectedUpdatedAt to fail with CONFLICT instead of overwriting somebody else's change.",
      inputSchema: {
        id: z.string().describe('Task ID (UUID)'),
        column: z
          .string()
          .describe('Target column name. Call get_columns for current names.'),
        actor: actorSchema,
        expectedUpdatedAt: expectedUpdatedAtSchema,
      },
      outputSchema: taskOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id, column, actor, expectedUpdatedAt }) => {
      try {
        const task = store.moveTask(id, column, { actor, expectedUpdatedAt });
        return ok({ ...toPublicTask(task) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'update_task',
    {
      title: 'Update Task',
      description:
        "Update a task's title, description, priority, assignee, project and/or column in one atomic operation. The task must end up with a project: omit projectId to keep the current one, or pass a new id to move the task to another project. Use expectedUpdatedAt to fail with CONFLICT instead of overwriting somebody else's change.",
      inputSchema: {
        id: z.string().describe('Task ID (UUID)'),
        title: z
          .string()
          .min(1)
          .max(LIMITS.title)
          .optional()
          .describe('New task title'),
        description: z
          .string()
          .max(LIMITS.description)
          .optional()
          .describe('New task description'),
        priority: prioritySchema.optional(),
        assignee: z
          .string()
          .max(LIMITS.assignee)
          .optional()
          .describe('New assignee name (empty string to unassign)'),
        column: z
          .string()
          .optional()
          .describe('New column name. Call get_columns for current names.'),
        projectId: projectIdSchema,
        actor: actorSchema,
        expectedUpdatedAt: expectedUpdatedAtSchema,
      },
      outputSchema: taskOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      id,
      title,
      description,
      priority,
      assignee,
      column,
      projectId,
      actor,
      expectedUpdatedAt,
    }) => {
      // An explicit null is a caller error: it must fail rather than silently
      // keep the current project.
      if (projectId === null) {
        return toolError(
          new BoardError(
            'INVALID_PROJECT',
            'projectId must be a project id string; omit it to keep the current project.',
          ),
        );
      }

      try {
        const task = store.updateTask(id, {
          title,
          description,
          priority,
          assignee,
          column,
          projectId,
          actor,
          expectedUpdatedAt,
        });
        return ok({ ...toPublicTask(task) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'delete_task',
    {
      title: 'Delete Task',
      description:
        'Permanently delete a task from the board. Use only for erroneous or test tasks: this cannot be undone.',
      inputSchema: {
        id: z.string().describe('Task ID (UUID) to delete'),
      },
      outputSchema: {
        message: z.string().describe('Confirmation message'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        store.deleteTask(id);
        return ok({ message: `Task "${id}" has been deleted.` });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'attach_image',
    {
      title: 'Attach Image',
      description:
        'Attach an image (PNG, JPEG, GIF or WebP) to a task. Prefer path: it points at a file on the machine running the Kanbrawl server. Use base64 data only when no file path is available. The image type is sniffed from the bytes; the declared mimeType is ignored.',
      inputSchema: {
        taskId: z.string().describe('Task ID (UUID) to attach the image to'),
        path: z
          .string()
          .optional()
          .describe(
            'Path to an image file on the server machine (preferred over data)',
          ),
        data: z
          .string()
          .optional()
          .describe(
            'Base64-encoded image bytes (fallback when path is unusable)',
          ),
        filename: z
          .string()
          .optional()
          .describe('Display name for the attachment (default: from path)'),
        mimeType: z
          .string()
          .optional()
          .describe('Ignored: the image type is sniffed from the bytes'),
      },
      outputSchema: attachmentSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ taskId, path, data, filename }) => {
      try {
        const meta = store.addAttachment(taskId, {
          data: readImageBytes(path, data),
          filename:
            filename ?? (path === undefined ? undefined : basename(path)),
        });
        return ok({ ...meta });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_attachment',
    {
      title: 'Get Attachment',
      description:
        'Get an attached image: metadata as text plus the image bytes as an ImageContent block.',
      inputSchema: {
        attachmentId: z.string().describe('Attachment ID (UUID)'),
      },
      outputSchema: attachmentSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ attachmentId }) => {
      const attachment = store.getAttachment(attachmentId);
      if (!attachment) {
        return toolError(
          new BoardError(
            'ATTACHMENT_NOT_FOUND',
            `Attachment with id "${attachmentId}" not found.`,
          ),
        );
      }

      const { meta } = attachment;
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
          {
            type: 'image' as const,
            data: Buffer.from(attachment.data).toString('base64'),
            mimeType: meta.mimeType,
          },
        ],
        structuredContent: { ...meta },
      };
    },
  );

  server.registerTool(
    'delete_attachment',
    {
      title: 'Delete Attachment',
      description:
        'Remove an image from a task. Use only for erroneous or test attachments: this cannot be undone.',
      inputSchema: {
        attachmentId: z.string().describe('Attachment ID (UUID) to delete'),
      },
      outputSchema: {
        message: z.string().describe('Confirmation message'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ attachmentId }) => {
      try {
        store.deleteAttachment(attachmentId);
        return ok({
          message: `Attachment "${attachmentId}" has been deleted.`,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function readImageBytes(path?: string, data?: string): Uint8Array {
  if (path !== undefined && path.length > 0) {
    try {
      return new Uint8Array(readFileSync(path));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BoardError(
        'INVALID_ATTACHMENT',
        `Cannot read image file "${path}": ${reason}`,
      );
    }
  }

  if (data !== undefined) {
    return Uint8Array.from(Buffer.from(data, 'base64'));
  }

  throw new BoardError(
    'INVALID_ATTACHMENT',
    'Provide an image either as path (preferred) or as base64 data.',
  );
}
