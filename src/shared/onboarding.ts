import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type McpTarget = {
  name: string;
  configPath: string;
  serversKey: string;
  entry: Record<string, unknown>;
};

const PACKAGE_SPEC = 'github:alexkutkin/kanbrawl';
const STDIO_ARGS = ['-y', PACKAGE_SPEC, 'start', '--stdio'];

export const MCP_TARGETS: McpTarget[] = [
  {
    name: 'VS Code / GitHub Copilot',
    configPath: '.vscode/mcp.json',
    serversKey: 'servers',
    entry: { type: 'stdio', command: 'npx', args: STDIO_ARGS },
  },
  {
    name: 'Claude Code',
    configPath: '.mcp.json',
    serversKey: 'mcpServers',
    entry: { command: 'npx', args: STDIO_ARGS },
  },
  {
    name: 'Cursor',
    configPath: '.cursor/mcp.json',
    serversKey: 'mcpServers',
    entry: { command: 'npx', args: STDIO_ARGS },
  },
  {
    name: 'Gemini CLI',
    configPath: '.gemini/settings.json',
    serversKey: 'mcpServers',
    entry: { command: 'npx', args: STDIO_ARGS },
  },
  {
    name: 'Windsurf',
    configPath: '.windsurf/mcp.json',
    serversKey: 'mcpServers',
    entry: { command: 'npx', args: STDIO_ARGS },
  },
];

export const AGENTS_SECTION = `
## Task Management

Use the Kanbrawl MCP tools for task management when working on this project.

### Workflow

- Call \`get_columns\` when you need the current column names; they can be renamed
- When building a plan, include task creation in it
- Check existing tasks with \`list_tasks\` (it covers every column and reports \`total\`/\`hasMore\`) before creating to avoid duplicates
- Read a single task with \`get_task\` when you already have its ID
- Always reload tasks with \`list_tasks\` before starting work on a task to get the latest updates
- Set your name as assignee and pass \`actor\` when you change a task, so humans see who did it
- Pass \`expectedUpdatedAt\` from the task you read to get a \`CONFLICT\` instead of overwriting another agent's change
- Move tasks between columns with \`move_task\`, or change fields and column together with \`update_task\`
- Attach images to a task with \`attach_image\` (pass a file \`path\` when you can; base64 \`data\` is the fallback), and list them in \`get_task\`/\`list_tasks\`
- Read an image back with \`get_attachment\` (metadata plus the image bytes) and remove it with \`delete_attachment\`
- Proceed with task execution one at a time, till it's done or blocked then move to the next one
`;

export function writeMcpConfig(root: string, target: McpTarget): string {
  const fullPath = resolve(root, target.configPath);
  const dir = dirname(fullPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (existsSync(fullPath)) {
    try {
      existing = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {}
  }

  const servers =
    (existing[target.serversKey] as Record<string, unknown>) ?? {};
  servers.kanbrawl = target.entry;
  existing[target.serversKey] = servers;

  writeFileSync(fullPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  return target.configPath;
}

export function ensureAgentsSection(root: string): 'written' | 'skipped' {
  const agentsPath = resolve(root, 'AGENTS.md');

  if (existsSync(agentsPath)) {
    const content = readFileSync(agentsPath, 'utf8');
    if (content.includes('Kanbrawl MCP tools')) {
      return 'skipped';
    }

    writeFileSync(
      agentsPath,
      content.trimEnd() + '\n' + AGENTS_SECTION,
      'utf8',
    );
  } else {
    writeFileSync(agentsPath, `# AGENTS.md\n${AGENTS_SECTION}`, 'utf8');
  }

  return 'written';
}
