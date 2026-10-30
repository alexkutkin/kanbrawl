# Legacy task classification runbook

Every board created before the project catalog (and every board fed by the
one-time `kanbrawl.json` import) holds tasks without a project. Those tasks
are the **unclassified pool**: they stay visible with a "no project" badge and
are counted in the filter bar until they are classified. The board is done
migrating when that count reaches zero.

The server never calls an LLM. Classification is done by an agent working over
the normal MCP tools, so every step is reviewable and reversible.

## Rules that hold during the transition

- Creating a task still requires a project (`INVALID_PROJECT` otherwise).
- Editing an unclassified task requires choosing a project — the edit is the
  classification.
- Moving a task between columns never touches its project.
- Unclassified tasks are visible regardless of the quick filters.

## Steps

1. **Build the project list.** Call `get_projects`. If the list is empty,
   scan the workspace root and propose one `name` + `folder` pair per project
   (names in English), then have the owner approve and write the list with
   `update_projects`. See the decision record for why `folder` is plain
   metadata the server never validates.
2. **Dry run — no writes.** Read the content of each project folder and map
   every unclassified task to a proposed project. Produce a report with one
   line per task: `taskId → projectId` plus a one-line rationale. Put every
   task you are unsure about on a separate "uncertain" list for the owner
   instead of guessing.
3. **Owner review.** The owner approves or adjusts the report. Nothing has
   been written yet.
4. **Apply with optimistic locking.** For each task call `update_task` with
   the chosen `projectId` and the `expectedUpdatedAt` you saw in step 2. On
   `CONFLICT` re-read the task and decide again from its current state —
   never replay a stale decision.
5. **Resume freely.** The backfill is idempotent: after an interruption,
   repeat from step 2 for whatever is still unclassified. Re-running costs
   nothing and cannot corrupt data.
6. **Verify.** The filter bar counter reaches 0 and stays there. The board is
   fully migrated.

## Recovery

A misclassified task is a plain fix: `update_task` with the correct
`projectId`. Nothing else needs to change.
