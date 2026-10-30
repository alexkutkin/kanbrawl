<div align="center">

# 🥊 Kanbrawl

**A minimal live kanban board built for AI agents**

[![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D22-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-orange?style=flat-square)](LICENSE)

[Features](#features) · [Getting Started](#getting-started) · [CLI](#cli) · [Configuration](#configuration) · [MCP Tools](#mcp-tools) · [Architecture](#architecture) · [Development](#development)

![Animation showing the Copilot agent using Kanbrawl](./docs/images/demo.gif)

</div>

---

AI agents manage tasks on a kanban board through [MCP](https://modelcontextprotocol.io) tools. Humans follow along in a live web UI that updates in real-time via Server-Sent Events. Both agents and humans can create, edit, move, and delete tasks and attach images — all changes sync instantly.

## Features

- 🤖 **MCP Server** — Exposes kanban operations as MCP tools via HTTP or stdio
- 🖥️ **Live Web UI** — View updates in real-time and edit/update tasks with drag-and-drop
- 🖼️ **Image attachments** — Paste, drop or pick screenshots in the UI; agents attach them over MCP
- ⌨️ **CLI** — Easy setup to configure your AI tools, create and update tasks from the terminal
- 🗄️ **Single SQLite file** — All board config, tasks and images live in `kanbrawl.db`
- 🔧 **Customizable** — Configure columns to fit your workflow
- 📦 **Zero infrastructure** — Embedded storage, no external services

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) >= 22

### Quick Start

Run the interactive setup in your project directory:

```bash
npx github:alexkutkin/kanbrawl init
```

This will:
1. Let you select your AI tools (VS Code Copilot, Claude Code, Cursor, Gemini CLI, Windsurf)
2. Generate the appropriate MCP config files using stdio transport
3. Create a `kanbrawl.db` board database with default columns
4. Append a Kanbrawl usage section to `AGENTS.md`

That's it — your AI agent can now use MCP tools to manage tasks on the board.

### View the Board

To launch the web UI and HTTP MCP server:

```bash
npx github:alexkutkin/kanbrawl start
```

Open [http://localhost:8431](http://localhost:8431) to view the board. By default the server binds to loopback only; start it with `--host 0.0.0.0` to share the board on your local network. The board has no authentication, so anyone who can reach the port can view and edit it.

### Run with Docker

```bash
docker compose up --build -d
```

The board is available at [http://localhost:8431](http://localhost:8431) and the MCP endpoint at `http://localhost:8431/mcp`. Board data is persisted in the `./data` folder next to `docker-compose.yml`, bind-mounted at `/data`.

The container listens on all interfaces and the board has no authentication. The published port is reachable by anyone who can connect to this machine. The server rejects browser requests whose `Origin` is not loopback, the same host, or listed via `--allow-origin`. If other devices cannot connect, allow inbound TCP port 8431 in the host firewall.

### Manual MCP Configuration

If you prefer to configure your MCP client manually instead of using `kanbrawl init`:

**Stdio transport** (recommended):

```json
{
  "mcpServers": {
    "kanbrawl": {
      "command": "npx",
      "args": ["-y", "github:alexkutkin/kanbrawl", "start", "--stdio"]
    }
  }
}
```

**HTTP transport** (requires a running server):

```json
{
  "mcpServers": {
    "kanbrawl": {
      "type": "http",
      "url": "http://localhost:8431/mcp"
    }
  }
}
```

## CLI

The `kanbrawl` CLI (also aliased as `kb`) provides the following commands:

```bash
kanbrawl                    # Start HTTP server (default)
kanbrawl start              # Start HTTP server
kanbrawl start --stdio      # Start MCP server over stdio transport
kanbrawl start -p 9000      # Start HTTP server on port 9000
kanbrawl start --host 0.0.0.0  # Expose on the local network (no authentication)
kanbrawl task "title"       # Create a task
kanbrawl task "title" -u    # Update existing task by title match
kanbrawl init               # Interactive setup for AI tools
kanbrawl --version          # Show version
kanbrawl --help             # Show help
```

`start` options for HTTP mode: `-p, --port`, `-H, --host` (defaults to `127.0.0.1`, or `0.0.0.0` inside a container), and `--allow-origin <origin…>` for additional browser origins.

### `task` command

Create or update tasks directly from the terminal:

```bash
kanbrawl task "Fix login bug" -p 0 -a alice -c "In progress"
kanbrawl task "Fix login bug" -u -c "Done"
```

| Option | Description |
|--------|-------------|
| `-d, --description <text>` | Task description |
| `-c, --column <name>` | Target column |
| `-p, --priority <level>` | Priority (0, 1, or 2; default 1) |
| `-a, --assignee <name>` | Task assignee |
| `-u, --update` | Update existing task by title match |

### `init` command

Interactive setup that:
1. Prompts to select AI tools (VS Code Copilot, Claude Code, Cursor, Gemini CLI, Windsurf)
2. Generates MCP config files with stdio transport for each selected tool
3. Creates `kanbrawl.db` with default columns if missing
4. Appends a Kanbrawl usage section to `AGENTS.md`

## Configuration

All configuration and data lives in a single SQLite database, `kanbrawl.db`,
auto-created on first run:

- **Columns** — identities, names, order and sorting (`priority`, `created` or
  `updated`); defaults to Todo, In progress, Blocked, Done
- **Projects** — the managed project catalog: unique names with free-form
  folder paths, stored as plain metadata and never validated against the
  filesystem
- **Theme** — optional `light`/`dark` UI theme override
- **Tasks** — tasks with their history metadata
- **Attachments** — images (PNG, JPEG, GIF or WebP, up to 10 MB and 10 per
  task), stored content-addressed by SHA-256

Schema changes are applied through versioned migrations tracked in
`PRAGMA user_version`; upgrading an existing database in place is safe and the
migration is idempotent, so re-running it is a no-op.

If a legacy `kanbrawl.json` sits next to the database, it is imported once on
startup and renamed to `kanbrawl.json.imported`.

> [!TIP]
> Column names are what agents pass to MCP tools. Rename a column through the board's settings (⚙) to keep task references consistent; editing the database directly is not recommended.

## MCP Tools

All tools are available via the `/mcp` endpoint.

| Tool | Description | Read-only |
|------|-------------|-----------|
| `get_columns` | Get columns with task counts | ✅ |
| `get_projects` | Get the project catalog with its revision | ✅ |
| `get_task` | Get one task by id | ✅ |
| `list_tasks` | List tasks across all columns, with `total`, `hasMore` and `offset` | ✅ |
| `create_task` | Create a new task (with priority, assignee, `clientRequestId`) | ❌ |
| `move_task` | Move a task to a different column | ❌ |
| `update_task` | Update task fields (title, description, column, priority, assignee) | ❌ |
| `delete_task` | Delete a task | ❌ |
| `update_projects` | Replace the full project list (rename, reorder, add, delete) | ❌ |
| `attach_image` | Attach an image to a task (file `path` preferred, base64 `data` fallback) | ❌ |
| `get_attachment` | Get an attachment's metadata plus its image bytes | ✅ |
| `delete_attachment` | Remove an image from a task | ❌ |

Mutations accept `actor` so the board can show who last changed a task. Pass `expectedUpdatedAt` (or `expectedVersion` on `move_task`) to turn a lost update into a `CONFLICT` error instead of silently overwriting another agent's change.

`update_projects` and `PUT /api/projects` replace the whole project list in one
atomic change; a rejected project rolls back the entire call. Pass
`expectedRevision` to turn a stale write into a `CONFLICT` error; without it
the write is last-write-wins and can overwrite concurrent changes. The
revision increments on every accepted change regardless of writer.

## Architecture

```mermaid
graph LR
  subgraph Clients
    A["🤖 AI Agents"]
    B["🖥️ Web Browser"]
  end

  subgraph Server ["Express 5 Server"]
    MCP["MCP Endpoint<br/><code>/mcp</code>"]
    API["REST API<br/><code>/api/*</code>"]
    SSE["SSE Endpoint<br/><code>/events</code>"]
    Store["BoardStore"]
  end

  DB[("kanbrawl.db")]

  A -- "MCP tools<br/>(Streamable HTTP)" --> MCP
  B -- "REST calls" --> API
  B -. "real-time events" .-o SSE

  MCP --> Store
  API --> Store
  Store -- "read/write" --> DB
  Store -- "emit events" --> SSE
```

**How it works:**

1. **AI agents** call MCP tools (e.g. `create_task`) via the `/mcp` Streamable HTTP endpoint
2. **Humans** interact through the web UI, which calls the REST API at `/api/*`
3. All mutations flow through the **BoardStore**, which persists data to `kanbrawl.db` and emits change events
4. The **SSE manager** broadcasts events to all connected browser clients for real-time updates

## Development

### Dev Mode

Runs the Express server with auto-reload and Vite dev server with HMR:

```bash
npm run dev
```

| Service | URL | Description |
|---------|-----|-------------|
| Server | [localhost:8431](http://localhost:8431) | API, MCP, SSE |
| Client | [localhost:5173](http://localhost:5173) | Vite dev with proxy |

### Build

```bash
npm run build          # Build both server and client
npm run build:server   # Build server only (tsc)
npm run build:client   # Build client only (vite)
npm run clean          # Remove dist/
```

