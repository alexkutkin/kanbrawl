// Builds the project when it is installed straight from git (for example
// `npx github:alexkutkin/kanbrawl init`), where dist/ does not ship with the
// install. Skips when dist/ is already built or when the build tooling is not
// installed (production installs ship a prebuilt dist/).
import { existsSync } from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const alreadyBuilt = existsSync(
  new URL('../dist/server/index.js', import.meta.url),
);
const toolingInstalled = existsSync(
  new URL('../node_modules/typescript/package.json', import.meta.url),
);

if (!alreadyBuilt && toolingInstalled) {
  const result = spawnSync('npm', ['run', 'build'], {
    stdio: 'inherit',
    shell: true,
    cwd: new URL('..', import.meta.url),
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}
