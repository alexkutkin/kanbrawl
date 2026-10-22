# Task detail dialog

Clicking a card opens a native modal dialog with the full description, priority, column, and metadata. Escape, the close button, or a backdrop click dismisses it without changing the task.

## Sub-features

- `detail-open` opens the dialog from a card click.
- `detail-content` shows title, full description, priority, column, assignee, and timestamps.
- `detail-escape` closes with Escape and keeps the task.
- `detail-close-button` closes with the `Close task details` button.

## How to get to it (user POV)

- Click a card body (not its edit/delete buttons) to open the centered dialog.
- Press `Escape`, choose the `✕` button, or click outside the dialog to close it.

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- A task exists in `In progress` with a multi-line description, priority `P0`, and assignee `detail-agent` (the runner seeds it through `POST /api/tasks`).

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs task-detail`.
- **Open.** The runner clicks the card's `.task-card`. `dialog.task-detail` becomes visible with the native `open` property set.
- **Check content.** `.detail-task-title` matches the task title; `.detail-description` matches the two-line description; `.detail-badge.priority-P0` reads `P0`; `.detail-badge.column` reads `In progress`; the first `.detail-meta dd` reads `detail-agent`.
- **Escape.** The runner presses `Escape`; no `dialog.task-detail[open]` remains, and the card is still in `In progress` and still returned by the API.
- **Close button.** Reopen the dialog and choose `button[aria-label="Close task details"]`; the open dialog disappears.
- **Read the proof.** Exit code `0`, `✔ task-detail: 3/3 checks passed`, `✔ task-detail verified`, and `00-detail-dialog.png` with the modal and its metadata visible.

## Gotchas

- Clicking the edit or delete action button does not open the dialog; the card handler ignores those targets. Click the card body.
- The dialog is a native `<dialog>` opened with `showModal()`, so test focus/escape behavior against the real element; a hidden `dialog.task-detail` still exists in the DOM when closed. Assert on the `open` attribute (or `element.open`), not on existence.
- The description uses `white-space: pre-wrap`, so `innerText` includes template indentation; trim before comparing.
- Deleting the task while its dialog is open closes the dialog; not covered by this scenario.
- Multiple dialogs cannot stack: the app renders one detail dialog and reuses it.
