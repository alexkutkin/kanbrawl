# Column settings

A human can rename columns, add a column, reorder columns, and choose the sort field and direction used inside each column. Saving persists the configuration and re-renders the board.

## Sub-features

- `columns-rename` renames an existing column.
- `columns-add` appends a new column.
- `columns-reorder` moves a column up or down before saving.
- `columns-sort` changes a column's sort field and direction.
- `columns-save` persists the whole configuration and broadcasts it.

## How to get to it (user POV)

- Choose the gear (`Configure columns`) in the header.
- In the modal, edit column name inputs, choose `+ Add column`, use `Move up` / `Move down`, and change the two `Sort` selects per column.
- Choose `Save` to apply, `Cancel` or `Escape` to discard.

## Driving it with drive.mjs

Preconditions:

- The verify instance is running and `doctor.mjs` exits 0.
- The board is reset to the four default columns (the runner does this) and has two tasks in `Todo` with priorities `P2` and `P0`.

- **Run the scenario.** Run `node .agents/skills/verify-kanbrawl/scripts/drive.mjs columns`.
- **Open settings.** The runner chooses `kanbrawl-column-settings .settings-btn`; the modal (`.modal`) shows one `.column-row input` per column.
- **Rename.** The runner fills the third input (index 2, `Blocked`) with `On hold`.
- **Add and reorder.** The runner chooses `+ Add column`, fills the new last input with `Review`, then chooses that row's `Move up`. The board order after saving is `Todo`, `In progress`, `On hold`, `Review`, `Done`.
- **Sort.** The runner sets the first column's sort field to `priority` and direction to `desc`.
- **Save.** The runner chooses `.btn-save`. The board re-renders with the new names, and `GET /api/board` returns the same five columns plus `sortBy: "priority"`, `sortOrder: "desc"` on `Todo`.
- **Check the effect.** The two seeded tasks render as the `P2` task first, then the `P0` task, proving the direction changed.
- **Read the proof.** Exit code `0`, `✔ columns: 2/2 checks passed`, `✔ columns verified`, and `00-columns-updated.png`.

## Gotchas

- `+ Add column` appends at the end (after `Done`); the scenario reorders it explicitly. Do not assume the new column lands where you want.
- `Save` is disabled while any column name is empty or duplicated; fill new rows before saving.
- Renaming a column removes the old name, and tasks in a removed column are moved to the first remaining column. Seed tasks in a column that keeps its name if you want to verify sorting, as this scenario does with `Todo`.
- Column changes go through `PUT /api/columns` and the app's column store, not through the card UI; assert both the rendered order and the API order.
- The modal is a plain overlay inside the component's shadow root, not a native `<dialog>`; target `.overlay .modal` handles.
