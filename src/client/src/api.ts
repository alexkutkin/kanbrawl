import type { Board, Column, Task } from './types.js';

const TOKEN_KEY = 'kanbrawl-token';

function readToken(): string | undefined {
  try {
    const fromUrl = new URLSearchParams(globalThis.location.search).get(
      'token',
    );
    if (fromUrl) {
      globalThis.sessionStorage.setItem(TOKEN_KEY, fromUrl);
      return fromUrl;
    }

    return globalThis.sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

const token = readToken();

export function authToken(): string | undefined {
  return token;
}

export function eventsUrl(): string {
  return withToken('/events');
}

function withToken(path: string): string {
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

function headers(json: boolean): Record<string, string> {
  const result: Record<string, string> = {};
  if (json) result['Content-Type'] = 'application/json';
  if (token) result['x-kanbrawl-token'] = token;
  return result;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly details?: { availableColumns?: string[]; current?: Task },
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(withToken(path), init);
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
          details?: { availableColumns?: string[]; current?: Task };
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
