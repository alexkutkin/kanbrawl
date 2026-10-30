import type {
  AttachmentMeta,
  Board,
  Column,
  Project,
  Task,
} from '../../shared/board.js';

export function eventsUrl(): string {
  return '/events';
}

export function attachmentUrl(id: string): string {
  return `/api/attachments/${encodeURIComponent(id)}`;
}

function headers(json: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  if (json) result['Content-Type'] = 'application/json';
  return result;
}

export type ApiErrorDetails = {
  availableColumns?: string[];
  current?: Task;
  currentRevision?: number;
  projects?: Project[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(
      'Cannot reach the Kanbrawl server. Check that it is still running.',
    );
  }

  if (!response.ok) {
    let body:
      | {
          error?: string;
          code?: string;
          details?: ApiErrorDetails;
        }
      | undefined;
    try {
      body = (await response.json()) as typeof body;
    } catch {}

    throw new ApiError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code,
      body?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function fetchBoard(): Promise<Board> {
  return request<Board>('/api/board');
}

export type CreateTaskFields = {
  title: string;
  description?: string;
  column?: string;
  priority?: string;
  assignee?: string;
  actor?: string;
  clientRequestId?: string;
};

export async function createTask(fields: CreateTaskFields): Promise<Task> {
  return request<Task>('/api/tasks', {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(fields),
  });
}

export type UpdateTaskFields = {
  title?: string;
  description?: string;
  column?: string;
  priority?: string;
  assignee?: string;
  actor?: string;
  expectedUpdatedAt?: string;
};

export async function updateTask(
  id: string,
  fields: UpdateTaskFields,
): Promise<Task> {
  return request<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: headers(true),
    body: JSON.stringify(fields),
  });
}

export async function deleteTask(id: string): Promise<void> {
  await request<void>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(false),
  });
}

export async function updateColumns(
  columns: Column[],
  moveTo?: string,
): Promise<{ columns: Column[] }> {
  return request<{ columns: Column[] }>('/api/columns', {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify({ columns, moveTo }),
  });
}

export type ProjectInput = {
  id?: string;
  name: string;
  folder: string;
};

export async function updateProjects(
  projects: ProjectInput[],
  expectedRevision?: number,
): Promise<{ projects: Project[]; revision: number }> {
  return request<{ projects: Project[]; revision: number }>('/api/projects', {
    method: 'PUT',
    headers: headers(true),
    body: JSON.stringify({ projects, expectedRevision }),
  });
}

export type AttachmentInput = {
  name?: string;
  body: Blob | Uint8Array;
};

export async function addAttachment(
  taskId: string,
  image: AttachmentInput,
): Promise<AttachmentMeta> {
  const query = image.name ? `?filename=${encodeURIComponent(image.name)}` : '';
  return request<AttachmentMeta>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: image.body as BodyInit,
    },
  );
}

export async function deleteAttachment(id: string): Promise<void> {
  await request<void>(`/api/attachments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: headers(false),
  });
}
