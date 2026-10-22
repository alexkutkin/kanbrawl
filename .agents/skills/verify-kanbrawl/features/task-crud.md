# Task create, edit, delete

A human can add a task from a column's `+ Add task` form, edit its title, description, priority, and assignee inline on the card, and delete it from the card actions. Every mutation is persisted and broadcast.

## Sub-features

- `task-create` adds a task from the column form with title, description, priority, and assignee.
- `task-edit` changes title, description, priority, and assignee from the card's edit form.
- `task-delete` removes the card and the stored task.
- `task-persist` mirrors each mutation through `GET /api/board` and the board file.

## How to get to it (user POV)

- Choose `+ Add task` at the bottom of a column, fill the form, and choose `Add task`.
- Hover a card and choose the pencil (`Edit`), change fields, and choose `Save`.
- Hover a card and choose the cross (`Delete`).

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- The board is reset to the four default columns with no tasks (the runner does this).

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs tasks`.
- **Create.** The runner clicks `+ Add task` in `Todo`, fills `input[placeholder="Task title"]`, the description textarea, selects `P0`, fills `input[placeholder="Assignee (optional)"]` with `human-verifier`, and chooses `Add task`. A card appears with the `P0` badge, the assignee chip, and the description; `GET /api/board` returns the same `priority`, `assignee`, `description`, and `column: "Todo"`.
- **Edit.** The runner hovers the card, chooses `button[title="Edit"]`, changes the title to `<title> edited`, sets priority `P2`, assignee `robot-editor`, and description `Edited in the web UI`, then chooses `Save`. The card and the API both show the new values.
- **Delete.** The runner hovers the edited card and chooses `button[title="Delete"]`. The card disappears from `Todo` and the task is gone from `GET /api/board`.
- **Read the proof.** Exit code `0`, `✔ tasks: 3/3 checks passed`, `✔ tasks verified`, and screenshots `00-created-via-ui.png`, `01-edited-via-ui.png`, `02-deleted-via-ui.png`.

## Gotchas

- Card action buttons are transparent until hover; the runner hovers before clicking. A click without hover still lands but looks unverified in a screenshot.
- The edit form's first text input is the title; the assignee input is identified by its placeholder.
- After `Delete`, the API can answer before the SSE removal reaches the DOM. Wait for the card to disappear from the column, not only for the API to drop it.
- Titles are trimmed by the API. Assert the trimmed value.
- The create form closes immediately and clears itself; reopening it shows empty fields, not the previous draft.
