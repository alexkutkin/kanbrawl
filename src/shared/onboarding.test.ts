import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MCP_TARGETS,
  ensureAgentsSection,
  writeMcpConfig,
} from './onboarding.js';

describe('onboarding', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanbrawl-onboarding-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('MCP_TARGETS', () => {
    it('lists the five supported clients', () => {
      expect(MCP_TARGETS.map((target) => target.name)).toEqual([
        'VS Code / GitHub Copilot',
        'Claude Code',
        'Cursor',
        'Gemini CLI',
        'Windsurf',
      ]);
    });

    it('uses the servers key for VS Code and mcpServers elsewhere', () => {
      expect(MCP_TARGETS[0].serversKey).toBe('servers');
      expect(
        MCP_TARGETS.slice(1).every((t) => t.serversKey === 'mcpServers'),
      ).toBe(true);
    });
  });

  describe('writeMcpConfig', () => {
    it('creates nested config files with the kanbrawl entry', () => {
      expect(writeMcpConfig(dir, MCP_TARGETS[0])).toBe('.vscode/mcp.json');

      const data = JSON.parse(
        readFileSync(join(dir, '.vscode/mcp.json'), 'utf8'),
      ) as { servers: Record<string, unknown> };
      expect(data.servers.kanbrawl).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'kanbrawl', 'start', '--stdio'],
      });
    });

    it('merges without dropping other servers or sibling keys', () => {
      const filePath = join(dir, '.cursor/mcp.json');
      writeMcpConfig(dir, MCP_TARGETS[2]);
      const original = JSON.parse(readFileSync(filePath, 'utf8')) as Record<
        string,
        unknown
      >;
      original.settings = { theme: 'dark' };
      (original.mcpServers as Record<string, unknown>).other = {
        command: 'other-tool',
      };
      writeFileSync(filePath, JSON.stringify(original), 'utf8');

      writeMcpConfig(dir, MCP_TARGETS[2]);

      const data = JSON.parse(readFileSync(filePath, 'utf8')) as {
        settings: { theme: string };
        mcpServers: Record<string, unknown>;
      };
      expect(data.settings).toEqual({ theme: 'dark' });
      expect(data.mcpServers.other).toEqual({ command: 'other-tool' });
      expect(data.mcpServers.kanbrawl).toEqual({
        command: 'npx',
        args: ['-y', 'kanbrawl', 'start', '--stdio'],
      });
    });
  });

  describe('ensureAgentsSection', () => {
    it('creates AGENTS.md with the current workflow', () => {
      expect(ensureAgentsSection(dir)).toBe('written');

      const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(content.startsWith('# AGENTS.md')).toBe(true);
      expect(content).toContain('Kanbrawl MCP tools');
      expect(content).toContain('get_columns');
      expect(content).toContain('expectedUpdatedAt');
      expect(content).toContain('actor');
    });

    it('appends to an existing AGENTS.md', () => {
      writeFileSync(join(dir, 'AGENTS.md'), '# My Project\n\nExisting content');
      expect(ensureAgentsSection(dir)).toBe('written');

      const content = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
      expect(content).toContain('# My Project');
      expect(content).toContain('Existing content');
      expect(content).toContain('Kanbrawl MCP tools');
    });

    it('skips a file that already mentions the MCP tools', () => {
      const original = '# Project\n\nUse the Kanbrawl MCP tools\n';
      writeFileSync(join(dir, 'AGENTS.md'), original);

      expect(ensureAgentsSection(dir)).toBe('skipped');
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(original);
    });
  });
});
