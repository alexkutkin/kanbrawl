---
name: verify-kanbrawl
description: Verify Kanbrawl end to end by driving the real web UI and REST API with headless Playwright in a disposable Docker sandbox that the harness creates and removes itself (no browser window on the host). Use when a change touches the live board, SSE sync, task CRUD, drag-and-drop, the task detail dialog, column settings, or the REST/MCP data path.
---

# Verify Kanbrawl

Kanbrawl's user surface is a live kanban board: columns rendered from `kanbrawl.json`, cards that update over SSE, a native task-detail dialog, and drag-and-drop between columns. This skill launches an isolated instance, creates a disposable headless Playwright container, drives the instance inside it, and captures screenshots plus a machine-readable report.

Never open a browser on the host desktop, never use `--headed`, and never drive the user's real board on port `8431`.

## Launch

```bash
npm run build                                                        # required whenever src/ changed
node .agents/skills/verify-kanbrawl/scripts/launch.mjs
```

`launch.mjs` refuses to start when a verify instance is already recorded, wipes `.verify/run/data`, starts `bin/cli.js start --port 8473 --host 0.0.0.0` with that directory as its working directory, waits for `GET /api/board` to answer, then creates a disposable Playwright sandbox container. Ready means all of these printed lines appear:

```text
✔ Kanbrawl verify instance running on http://127.0.0.1:8473 (pid …)
✔ Board file: …/.verify/run/data/kanbrawl.json
✔ Columns: Todo, In progress, Blocked, Done
✔ disposable sandbox: kanbrawl-verify-8473-… (image playwright-sandbox)
  Container URL: http://host.docker.internal:8473
```

- The sandbox reaches the host through `host.docker.internal`, so the server binds `0.0.0.0`. The board has no authentication, so run this only on a machine and network where that is acceptable.
- The board file is isolated per run; the repository `kanbrawl.json` and the Dockerized board on `8431` are never touched.
- The sandbox container is named `kanbrawl-verify-<port>-<suffix>`, labelled `kanbrawl-verify=1`, and owned by this run. `cleanup.mjs` removes it; it is not the long-lived container other projects use.
- The server log is `.verify/run/server.log`. If port `8473` is busy the server picks another port, and `launch.mjs` records the actual one in `.verify/run/instance.json`.
- Teardown is `cleanup.mjs` (see below). A stale `instance.json` with a dead pid is overwritten by the next launch.

Environment overrides:

- `KB_VERIFY_PORT` — board port (default `8473`).
- `KB_PLAYWRIGHT_IMAGE` — image for the disposable sandbox (default `playwright-sandbox`). It must stay alive (e.g. `sleep infinity`) and contain Playwright at `<KB_PW_ROOT>/node_modules`.
- `KB_PLAYWRIGHT_CONTAINER` — reuse an already-running container instead of creating one. That container is left running at cleanup, only the scratch directory inside it is removed.
- `KB_PW_ROOT` — directory containing `node_modules/playwright` inside the image (default `/app`).

## Doctor

```bash
node .agents/skills/verify-kanbrawl/scripts/doctor.mjs
```

Read-only. Checks, each printed with `✔`/`✖`:

- the recorded pid is alive;
- the listening socket on the port belongs to that pid (not another process);
- `GET /api/board` returns 200;
- the API's tasks match `.verify/run/data/kanbrawl.json` (catches a stale or foreign instance);
- the sandbox container recorded for this run is running;
- the sandbox can reach the board URL, falling back to `http://172.17.0.1:<port>` and recording the working URL.

Non-zero exit means do not trust the instance: run `cleanup.mjs`, then `launch.mjs` again.

## Drive

```bash
node .agents/skills/verify-kanbrawl/scripts/drive.mjs <feature>
```

Features: `board`, `tasks`, `drag-drop`, `task-detail`, `columns`. See [features/README.md](features/README.md) for what each proves and the exact user path.

How a drive works:

1. `drive.mjs` copies `scripts/runner.mjs` into `/tmp/kb-verify/<run-id>/` inside the sandbox recorded for this run.
2. It executes the runner with `docker exec`, passing `KB_BASE_URL=http://host.docker.internal:<port>`, the feature id, and an evidence directory.
3. Chromium runs headless in the container; Lit open shadow DOM is pierced by Playwright CSS selectors, so selectors such as `kanbrawl-column .column-title` and `kanbrawl-task .task-title` work.
4. Every scenario first resets the board through the production REST API (delete all tasks, `PUT /api/columns` with the four defaults), so runs are repeatable.
5. After the run, evidence is copied back with `docker cp`, and host-side checks compare the served board with `kanbrawl.json` on disk.

Screenshots and the report land in `.verify/evidence/<run-id>-<feature>/`.

If the sandbox died or the image is unavailable, `drive.mjs` stops before touching the board. Recover with:

```bash
node .agents/skills/verify-kanbrawl/scripts/cleanup.mjs
node .agents/skills/verify-kanbrawl/scripts/launch.mjs
```

`launch.mjs` fails with a specific message when the image is missing or lacks Playwright, so point `KB_PLAYWRIGHT_IMAGE` / `KB_PW_ROOT` at a working image. Do not `npm install` Playwright on the host for verification.

## Evidence

Every drive writes to `.verify/evidence/<run-id>-<feature>/`:

- numbered PNGs in action order (`00-…`, `01-…`), full page, board identity (logo, columns) visible;
- `failure-NN.png` when a check fails, captured before teardown;
- `report.json` with `feature`, `ok`, `failure`, per-check `steps` (name, `ok`, duration, error), `shots`, `finalBoard`, and `hostChecks`.

Proof standards:

- Exercise the real user path — clicks, typing, native drag events — or, for the agent path, the real REST endpoints the CLI and MCP tools use. No internal setters or test-only hooks.
- Capture the action and the resulting state: the screenshot after the mutation plus the assert on the rendered DOM.
- Verify side effects, not just pixels: each scenario re-reads the task through `GET /api/board`, and `drive.mjs` compares that board with `.verify/run/data/kanbrawl.json` (task ids, columns, each task's column).
- A drive is only successful when the process exits 0 and prints `✔ <feature> verified`. A screenshot alone is not proof.

## Cleanup

```bash
node .agents/skills/verify-kanbrawl/scripts/cleanup.mjs
```

- Kills only the pid recorded in `.verify/run/instance.json` and waits for it to exit. Never kill by process name.
- Confirms the port is free (a different owner is reported, never killed).
- Removes the disposable sandbox container this run created (or, when reusing `KB_PLAYWRIGHT_CONTAINER`, only clears `/tmp/kb-verify` inside it).
- Deletes `.verify/run` (scratch data, log, instance record).
- Keeps `.verify/evidence/` untouched and prints how many runs are retained.

Run cleanup after every failed iteration too, otherwise the process, port, and container stay behind.

## Helpers

All helpers are plain Node ESM (Node >= 22) and run from the repository root.

| File | Runs on | Invocation |
| --- | --- | --- |
| `scripts/launch.mjs` | host | `node .agents/skills/verify-kanbrawl/scripts/launch.mjs` |
| `scripts/doctor.mjs` | host | `node .agents/skills/verify-kanbrawl/scripts/doctor.mjs` |
| `scripts/drive.mjs` | host | `node .agents/skills/verify-kanbrawl/scripts/drive.mjs <feature>` |
| `scripts/runner.mjs` | sandbox container (copied by `drive.mjs`) | not invoked directly |
| `scripts/probe-url.mjs` | sandbox container (copied by `doctor.mjs`) | not invoked directly |
| `scripts/cleanup.mjs` | host | `node .agents/skills/verify-kanbrawl/scripts/cleanup.mjs` |
| `scripts/lib.mjs` | host | shared paths/helpers, not invoked directly |

## Not covered here

`kanbrawl start --stdio`, the VS Code extension, and the MCP HTTP endpoint are separate surfaces. The REST API used by these scenarios is the same data path the MCP tools and CLI write through, but MCP handshake behavior itself is not driven by this skill.
