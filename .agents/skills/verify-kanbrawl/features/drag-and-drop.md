# Drag and drop

A human can drag a task card from one column to another; the drop moves the task server-side and every connected client follows.

## Sub-features

- `dnd-move` moves a card to the column it is dropped on.
- `dnd-persist` stores the new column and returns it from the API.
- `dnd-clean` clears the `drag-over` highlight after the drop.

## How to get to it (user POV)

- Grab a card by its body in one column and drop it on another column (works with mouse drag; touch uses a 300 ms long-press).

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- A task exists in `Todo` (the runner seeds one through `POST /api/tasks`).

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs drag-drop`.
- **Drag.** The runner performs a native drag from the card element to the `Done` column (`kanbrawl-column` host). The card leaves `Todo` and appears under `Done`; `GET /api/board` reports `column: "Done"`.
- **Check the drop state.** The `Done` column no longer carries the `drag-over` class.
- **Check persistence.** The host-side check confirms the served task and the entry in `.verify/run/data/kanbrawl.db` agree on the column.
- **Read the proof.** Exit code `0`, `✔ drag-drop: 2/2 checks passed`, `✔ drag-drop verified`, and `00-after-drag.png`.

## Gotchas

- Drop handling lives on the `kanbrawl-column` host, so drag onto the column element, not onto an inner list or a card.
- Dropping a task onto its own column is ignored by design; the scenario always uses a different column.
- A card in edit mode cannot be dragged (its `dragstart` is prevented).
- The `drag-over` class is added/removed on the host, so inspect the host's class attribute, not a shadow child.
- Touch drag requires a long press and vibration support; this scenario uses mouse drag only.
