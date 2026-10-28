import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { checkbox } from '@inquirer/prompts';
import {
  MCP_TARGETS,
  ensureAgentsSection,
  ensureBoardFile,
  writeMcpConfig,
  type McpTarget,
} from '../../shared/onboarding.js';

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
  if (ensureBoardFile(cwd, randomUUID) === 'exists') {
    console.log('  ⏭️  kanbrawl.json already exists, skipping');
  } else {
    console.log('  ✅ kanbrawl.json');
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
