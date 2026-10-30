# Managed project catalog with full-list replace and versioned schema migrations

Kanbrawl tasks had no notion of a project. We decided to add a managed project
catalog to the board — `projects(id, position, name UNIQUE, folder)`, referenced
by stable id — managed as one atomic full-list replacement (`PUT /api/projects`
and the `update_projects` MCP tool) with an optional optimistic revision, and to
evolve the SQLite schema through explicit versioned migrations tracked in
`PRAGMA user_version` instead of best-effort `CREATE TABLE IF NOT EXISTS`.
Status: accepted.

## Sources

| Source | Rule carried over | Why it applies |
|---|---|---|
| GitHub Issue Forms (`validations.required`) | Options are non-empty and unique; intake is gated at the authoritative layer | The catalog is enforced in `BoardStore`, not just in the UI — agents use REST/MCP directly |
| Trello Custom Fields | Field definitions live at board level, values on cards | The project list is board configuration; tasks reference one project by id |
| Trello Custom Fields (counter-example) | Deleting an option wipes it from every card, irreversible | We block deleting a project that still holds tasks (`PROJECT_NOT_EMPTY`) instead |
| Linear projects | An issue belongs to exactly one project | Projects group work around one outcome |
| Jira quick filters | Filter controls above the board | Out of scope here; the catalog is the base for the quick-filter chips |

## Considered options

- **Free-text project string (like `assignee`)** — rejected: the requirement is
  a managed list with unique names, not uncontrolled vocabulary.
- **Generic custom-fields engine (Trello-style)** — rejected: overkill for
  exactly one field on a minimal board.
- **`folder` UNIQUE** — rejected: monorepos (several projects, one folder) and
  multiple checkouts (one project, several folders) are legitimate, and string
  uniqueness is a false guarantee for Windows path aliases. `folder` is stored
  exactly as given and never validated against the filesystem (the server runs
  in Docker; folders live on the host).
- **Mandatory `expectedRevision`** — rejected: it forces a read-modify-write
  dance on every agent write. The revision is optional; a write without it is
  documented last-write-wins, while the UI always sends the revision its draft
  was based on. The revision increments on every accepted change, regardless of
  writer.
- **Never-empty catalog (`PROJECTS_REQUIRED`)** — rejected: it blocks fresh
  board bootstrap for no safety gain (`PROJECT_NOT_EMPTY` already keeps the
  catalog consistent with task counts). An empty list is a valid state.
- **Task deletion via `moveTo` on project removal (like columns)** — rejected
  for the follow-up work: required project selection means "move first, delete
  later" is the natural order, so deletion is blocked instead.

## Consequences

- Renaming or reordering a project never touches task rows: tasks reference
  projects by id, unlike `column_name`, which is a name-based reference.
- `PUT /api/projects` replaces the whole list in one transaction; any rejected
  item (duplicate name, invalid entry, busy project) rolls back the whole
  change.
- Schema changes are now explicit migrations: each version runs in a single
  transaction, is idempotent, and a fresh database converges to the same state
  as an upgraded one. An interrupted migration rolls back with its version
  bump and is safe to re-run.
- The `tasks.project_id` column and its `ON DELETE RESTRICT` foreign key land
  with the first migration, so later project-aware task semantics need no
  further schema change.
