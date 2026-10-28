# Task create, edit, delete

A human adds a task from a column's `+ Add task` button, edits it from the card's pencil, and deletes it from the card actions. Create, view, and edit share one centered native dialog; every mutation is persisted and broadcast.

## Sub-features

- `task-create` opens the task dialog in create mode from a column, prefilled with that column, and accepts title, description, priority, and assignee.
- `task-edit` opens the same dialog in edit mode from the card pencil.
- `task-delete` removes the card and the stored task.
- `task-persist` mirrors each mutation through `GET /api/board` and the board file.

## How to get to it (user POV)

- Choose `+ Add task` at the bottom of a column: the dialog opens with empty fields and the clicked column selected.
- Change the `Column` select in the dialog sidebar if the task belongs elsewhere, then choose `Add task`.
- Hover a card and choose the pencil (`Edit`): the same dialog opens in edit mode. Change fields and choose `Save`; the dialog returns to view mode.
- Hover a card and choose the cross (`Delete`), then confirm in the `Delete task?` dialog.

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- The board is reset to the four default columns with no tasks (the runner does this).

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs tasks`.
- **Create.** The runner clicks `+ Add task` in `Todo`, waits for `dialog.task-detail`, fills `input[placeholder="Task title"]`, the description textarea, selects `P0`, fills `input[placeholder="Name (optional)"]` with `human-verifier`, and chooses the form's submit button. The dialog closes, a card appears with the `P0` badge, the assignee chip, and the description; `GET /api/board` returns the same `priority`, `assignee`, `description`, and `column: "Todo"`.
- **Edit.** The runner hovers the card, chooses `button[title="Edit"]`, changes the title to `<title> edited`, sets priority `P2`, assignee `robot-editor`, and description `Edited in the web UI`, then chooses `Save`. The dialog switches back to view mode with `.detail-task-title` showing the new title; the runner presses `Escape` before touching the board again. The card and the API both show the new values.
- **Delete.** The runner hovers the edited card and chooses `button[title="Delete"]`. A native `dialog.confirm` opens; the runner chooses its `.btn-danger` (`Delete`). The card disappears from `Todo` and the task is gone from `GET /api/board`.
- **Read the proof.** Exit code `0`, `✔ tasks: 3/3 checks passed`, `✔ tasks verified`, and screenshots `00-create-dialog.png`, `01-created-via-ui.png`, `02-edit-dialog.png`, `03-edited-via-ui.png`, `04-deleted-via-ui.png`.

## Gotchas

- One dialog serves all three modes. The header reads `New task`, `Task detail`, or `Edit task`; assert on the visible form or title, not on a mode attribute.
- In create mode the only select inside `.detail-edit-form` is priority; the placement select is `#task-form-column` in the dialog sidebar.
- After `Save` the dialog stays open in view mode. Close it with `Escape`, the `✕` button, or a backdrop click before clicking cards behind it; the modal background is inert.
- Card action buttons are transparent until hover; the runner hovers before clicking.
- `Delete` on the card only opens the confirmation dialog; nothing is removed until `.btn-danger` in `dialog.confirm` is chosen. Cancel and Escape keep the task.
- After confirming, the API can answer before the SSE removal reaches the DOM. Wait for the card to disappear from the column, not only for the API to drop it.
- Titles are trimmed by the API. Assert the trimmed value.
- Closing the create dialog discards the draft; reopening it shows empty fields, not the previous input.
