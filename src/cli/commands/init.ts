import process from 'node:process';
import { resolve } from 'node:path';
import { checkbox } from '@inquirer/prompts';
import {
  MCP_TARGETS,
  ensureAgentsSection,
  writeMcpConfig,
  type McpTarget,
} from '../../shared/onboarding.js';
import { ensureBoardFile } from '../../server/store.js';

export async function initAction(): Promise<void> {
  console.log('🥊 Kanbrawl Setup\n');

  const selected = await checkbox<McpTarget>({
    message: 'Select AI tools to configure:',
    choices: MCP_TARGETS.map((target) => ({
      name: target.name,
      value: target,
    })),
  });

  if (selected.length === 0) {
    console.log('No tools selected. Exiting.');
    return;
  }

  const cwd = process.cwd();

  console.log('\n📋 Setting up board...');
  if (ensureBoardFile(resolve(cwd, 'kanbrawl.db')) === 'exists') {
    console.log('  ⏭️  kanbrawl.db already exists, skipping');
  } else {
    console.log('  ✅ kanbrawl.db');
  }

  console.log('\n🔧 Writing MCP configuration...');
  for (const target of selected) {
    writeMcpConfig(cwd, target);
    console.log(`  ✅ ${target.configPath}`);
  }

  console.log('\n📝 Updating AGENTS.md...');
  if (ensureAgentsSection(cwd) === 'skipped') {
    console.log('  ⏭️  AGENTS.md already contains Kanbrawl section, skipping');
  } else {
    console.log('  ✅ AGENTS.md');
  }

  console.log(
    '\n🎉 Kanbrawl is ready! Run `kanbrawl start` to launch the server.',
  );
}
