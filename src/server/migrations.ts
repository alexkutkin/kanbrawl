import type { DatabaseSync } from 'node:sqlite';

/**
 * Versioned schema migrations.
 *
 * The version is tracked in `PRAGMA user_version`. Every migration runs in a
 * single transaction and is idempotent: applying it to a database that
 * already carries its statements is a no-op, so a fresh database and one
 * upgraded from an older version end in the same schema state. An
 * interrupted migration rolls back together with its version bump and is
 * safe to re-run.
 */
export const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS columns (
  position INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL UNIQUE,
  sort_by TEXT NOT NULL,
  sort_order TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  name TEXT NOT NULL UNIQUE,
  folder TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  column_name TEXT NOT NULL,
  priority TEXT NOT NULL,
  assignee TEXT NOT NULL,
  last_actor TEXT NOT NULL,
  client_request_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks(column_name);
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL REFERENCES blobs(sha256),
  filename TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_task_idx ON attachments(task_id);
`;

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as
    | { user_version: number }
    | undefined;
  return Number(row?.user_version ?? 0);
}

function hasColumn(
  database: DatabaseSync,
  table: string,
  column: string,
): boolean {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

function migrateTo1(database: DatabaseSync): void {
  database.exec(MIGRATION_1);
  // Databases created before the project catalog exist without this column;
  // ALTER TABLE cannot express IF NOT EXISTS, so it is guarded explicitly.
  if (!hasColumn(database, 'tasks', 'project_id')) {
    database.exec(
      'ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT',
    );
  }

  database.exec(
    'CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id)',
  );
}

export function migrate(database: DatabaseSync): void {
  const version = readUserVersion(database);
  if (version >= SCHEMA_VERSION) return;

  database.exec('BEGIN IMMEDIATE');
  try {
    if (version < 1) {
      migrateTo1(database);
    }

    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {}

    throw error;
  }
}
