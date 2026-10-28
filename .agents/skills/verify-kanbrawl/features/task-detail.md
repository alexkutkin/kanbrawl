# Task detail dialog

Clicking a card opens a native modal dialog with the full description, priority, column, metadata, and the task's edit/delete/move controls. Escape, the close button, or a backdrop click dismisses it without changing the task. The open task is reflected in the URL as `#task/<id>`, so the dialog can be linked and reopened.

## Sub-features

- `detail-open` opens the dialog from a card click and sets `#task/<id>`.
- `detail-content` shows title, rendered description, priority, column, assignee, timestamps, and last actor.
- `detail-deep-link` opens the same dialog from a `#task/<id>` URL, including after reload.
- `detail-escape` closes with Escape and keeps the task.
- `detail-close-button` closes with the `Close task details` button.

## How to get to it (user POV)

- Click a card body (not its edit/delete buttons) to open the centered dialog.
- Press `Escape`, choose the `✕` button, or click outside the dialog to close it.
- From the dialog: `Copy ID`, the `Move to` select, `Edit` (the same dialog switches to edit mode), and `Delete` (which opens a confirmation dialog).
- The card pencil opens this dialog directly in edit mode; create mode uses the same shell from `+ Add task`.

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- A task exists in `In progress` with a multi-line description, priority `P0`, and assignee `detail-agent` (the runner seeds it through `POST /api/tasks`).

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs task-detail`.
- **Open.** The runner clicks the card's `.task-card`. `dialog.task-detail` becomes visible with the native `open` property set.
- **Check content.** `.detail-task-title` matches the task title; `.detail-description` matches the two-line description; `.detail-badge.priority-P0` reads `P0`; `.detail-badge.column` reads `In progress`; the first `.detail-meta dd` reads `detail-agent`.
- **Check the URL.** `location.hash` is `#task/<task id>`. Navigating directly to `<base>/#task/<id>` opens the same dialog.
- **Escape.** The runner presses `Escape`; no `dialog.task-detail[open]` remains, and the card is still in `In progress` and still returned by the API.
- **Close button.** Reopen the dialog and choose `button[aria-label="Close task details"]`; the open dialog disappears.
- **Read the proof.** Exit code `0`, `✔ task-detail: 3/3 checks passed`, `✔ task-detail verified`, and `00-detail-dialog.png` with the modal and its metadata visible.

## Gotchas

- Clicking the delete action button does not open the dialog; click the card body. The pencil does open the dialog, in edit mode, and also sets `#task/<id>`.
- Edit and create reuse the dialog's main column: `Save` returns to view mode without closing the dialog, while `Add task` closes it.
- The dialog is a native `<dialog>` opened with `showModal()`, so test focus/escape behavior against the real element; a hidden `dialog.task-detail` still exists in the DOM when closed. Assert on the `open` attribute (or `element.open`), not on existence.
- The description is rendered from a safe Markdown subset (paragraphs, headings, lists, code, emphasis, http(s)/mailto links), not `white-space: pre-wrap`; a two-line paragraph still reads as one text block, so trim before comparing.
- Each change to the task through SSE re-renders the open dialog; it always reflects the latest stored task.
- `Delete` inside the dialog opens the separate `dialog.confirm`; confirm there to remove the task. Closing the detail dialog first is not required.
- Multiple dialogs cannot stack: the app renders one detail dialog and one confirm dialog, and reuses them. A backdrop click is ignored while the click lands inside the dialog's box.
