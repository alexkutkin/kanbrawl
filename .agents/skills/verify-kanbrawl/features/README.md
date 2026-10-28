# Kanbrawl verification map

This directory is the maintained source for verifying Kanbrawl's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Repository dependencies are installed (`npm install`) and the app is built (`npm run build`).
- A disposable instance was started by `node .agents/skills/verify-kanbrawl/scripts/launch.mjs` and reported a pid, port, isolated board database, and the four default columns.
- `node .agents/skills/verify-kanbrawl/scripts/doctor.mjs` exits 0.
- The disposable Playwright sandbox created by `launch.mjs` (or a container named by `KB_PLAYWRIGHT_CONTAINER`) is running and can reach `http://host.docker.internal:<port>`.
- Never drive the user's real instance on port `8431`, and never drive an instance this run did not launch.

## Driving conventions

- Every `drive.mjs` invocation resets the board through the REST API (all tasks deleted, default columns restored), so each feature starts from the same baseline.
- Commands are literal and are run from the repository root.
- Browser actions run in headless Chromium inside the sandbox container through `docker exec`; nothing opens on the host desktop.
- Prefer the stable handles listed per feature (custom-element names, CSS classes, button titles, placeholders) over coordinates.
- User-path mutations must be confirmed twice: in the rendered DOM and through `GET /api/board`, plus the host-side comparison with `.verify/run/data/kanbrawl.db`.
- Record the feature id, run id, and evidence directory with every proof.

## Proof and skip reporting

- Capture the action and the resulting state, not only the final screen.
- A successful drive prints `✔ <feature> verified`, exits 0, and writes `report.json` plus numbered screenshots under `.verify/evidence/<run-id>-<feature>/`.
- A failed drive writes `failure-NN.png` and a `report.json` whose `steps` name the failing check and message. Report the failure as observed; do not rerun until it passes and call it verified.
- If a precondition above is unmet, report that feature as unverified with the failed precondition, not as skipped-but-passing.

## Features

- [Live board and sync](./board-live-sync.md) — rendering from the board database, empty state, and live task creation/move over SSE.
- [Task create, edit, delete](./task-crud.md) — the shared task dialog in create and edit modes, and deletion.
- [Drag and drop](./drag-and-drop.md) — moving a card between columns with native drag events.
- [Task detail dialog](./task-detail.md) — opening the native modal, its content, Escape, and the close button.
- [Column settings](./column-settings.md) — renaming, adding, reordering, sorting, saving, and persistence.
- [Image attachments](./attachments.md) — staging images while creating, immediate uploads in view/edit, thumbnails, the full-size viewer, and deletion.

Also user-facing but not mapped yet: theme toggle, column fold/unfold, CLI commands, `--stdio` MCP transport, the MCP HTTP endpoint, and the VS Code extension.
