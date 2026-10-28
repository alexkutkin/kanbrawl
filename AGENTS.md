# Kanbrawl

A minimal live kanban board for AI agents, powered by MCP (Model Context Protocol).

## Working agreement

### Communication

- Communicate with the owner in Russian.
- Keep everything the repository stores in English: code and comments, commit
  messages, test names, README, docs, ADRs, AGENTS.md, config comments.
- Content keeps its own language: product strings live in locale resources.

### Git

- Work directly on `main`. Create branches or pull requests only when requested.
- Use focused Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
- Do not add AI co-authorship or tool credits to commits or pull requests.
- Add `Signed-off-by` only when required.
- Commit and push only when requested. Push to `origin/main` unless otherwise specified.
- Do not force-push or rewrite published history without explicit approval.

## Definition of done

`npm run build`, `npm run lint`, and `npm test` all pass. New server features
(API routes, MCP tools, store methods) ship with tests in the matching
`src/server/*.test.ts`.

## Invariants

- Board state lives in a single SQLite database, `kanbrawl.db`; there is no
  external database or service. A legacy `kanbrawl.json` next to it is imported
  once and renamed to `kanbrawl.json.imported`.
- Every board mutation goes through `BoardStore`, which persists to disk and
  emits the SSE event.
- The board has no authentication: anyone who reaches the port can view and edit.
  It binds to loopback by default; `--host 0.0.0.0` exposes it on the network.
- MCP transport is stateless: a new transport per request, no sessions.
- REST errors are `{ error, code, details? }` with stable codes
  (`TASK_NOT_FOUND`, `COLUMN_NOT_FOUND`, `CONFLICT`, …); MCP tool errors are
  `isError` results whose text starts with `Error [CODE]:`.

## Docker

The live board runs from the image, not from `dist/`. After any change to
`src/`, `package.json`, `package-lock.json`, or the `Dockerfile`, rebuild and
recreate it, then confirm health and task count:

```bash
docker compose build kanbrawl
docker compose up -d
curl -s http://127.0.0.1:8431/healthz
curl -s http://127.0.0.1:8431/api/board
```

Board data lives in `./data/kanbrawl.db` (bind-mounted at `/data`, git-ignored).
Never recreate the container against an empty data folder; check the task count
after every rebuild.

## Task Management

Use the Kanbrawl MCP tools for task management when working on this project.

### Workflow

- When building a plan, include task creation in it
- Check existing tasks with `list_tasks` before creating to avoid duplicates
- Always reload tasks with `list_tasks` before starting work on a task to get the latest updates
- Set your name as assignee when you start working on a task
- Move tasks between columns with `move_task` to track progress
- Proceed with task execution one at a time, till it's done or blocked then move to the next one
- Don't forget to update the task status when you work on a task, so others know it's being worked on.
