# Live board and sync

The board renders columns and cards from `kanbrawl.json`, shows an empty state on a fresh board, and reflects task changes made by agents or the CLI without a page reload.

## Sub-features

- `board-render` renders the configured columns in file order with their task counts.
- `board-empty` shows `No tasks` in every empty column.
- `sync-create` adds a card when a task is created through the REST API (the path used by MCP tools and the CLI).
- `sync-move` moves the card when the task's column changes through the REST API.

## How to get to it (user POV)

- Open the board URL in a browser; the web UI is served by the same process as the API.
- Have an AI agent or `kanbrawl task "…"` create a task; the card appears in the target column while the page stays open.
- Move the task with an agent or `kanbrawl task "…" -u -c "In progress"`; the card changes column live.

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- The board is at the recorded port (default `8473`), not `8431`.

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs board`. The runner resets the board, opens the UI, and waits for the green connection dot (`.status-dot.connected`).
- **Check rendering.** The rendered column names are `Todo`, `In progress`, `Blocked`, `Done` in that order, and four `.empty-state` blocks read `No tasks`.
- **Check live create.** The runner posts a `P0` task assigned to `verify-agent` to `POST /api/tasks`. A card with that title, the `P0` badge, and the assignee chip appears in `Todo` without navigation.
- **Check live move.** The runner patches the task to `In progress`. The card leaves `Todo` and appears under `In progress`; `GET /api/board` reports `column: "In progress"`.
- **Read the proof.** Exit code `0`, `✔ board: 6/6 checks passed`, `✔ board verified`, and three screenshots: `00-empty-board.png`, `01-live-create.png`, `02-live-move.png`.

## Gotchas

- Mutating before the SSE connection is established makes the first assertion race; the runner waits for the green dot first.
- The card is rendered from the SSE event, not from the POST response, so a failure here means the event path is broken even if the API call succeeded.
- The scenario resets the board through the API on every run; the "empty board" assertion depends on that reset, not on the launch.
- Column titles are uppercased by CSS, so read the `name` property or use case-insensitive matching; do not match on rendered uppercase text.
- The reset restores the four default columns; if `DEFAULT_COLUMNS` in `src/server/store.ts` changes, update `scripts/runner.mjs` too.
