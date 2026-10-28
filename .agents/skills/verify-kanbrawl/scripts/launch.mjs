// Starts an isolated Kanbrawl instance for verification, plus a disposable
// headless Playwright sandbox container to drive it.
// Data lives in `.verify/run/data`, never in the repository root, so the real
// board file and the already-running instance on port 8431 stay untouched.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import {
  CONTAINER_MODULE_ROOT,
  DATA_DIR,
  LOG_FILE,
  PORT,
  REPO_ROOT,
  SANDBOX_IMAGE,
  containerBaseUrl,
  docker,
  dockerContainerRunning,
  dockerImageExists,
  fetchBoard,
  hostBaseUrl,
  isProcessAlive,
  ok,
  readInstance,
  readLog,
  resetRunDirectory,
  warn,
  writeInstance,
} from './lib.mjs';

const buildMarkers = ['dist/server/index.js', 'dist/client/index.html'];
for (const marker of buildMarkers) {
  if (!existsSync(join(REPO_ROOT, marker))) {
    console.error(`✖ Missing ${marker}. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

const previous = readInstance();
if (previous && isProcessAlive(previous.pid)) {
  console.error(
    `✖ A verify instance is already running (pid ${previous.pid}, port ${previous.port}).\n` +
      '  Run `node .agents/skills/verify-kanbrawl/scripts/cleanup.mjs` before launching again.',
  );
  process.exit(1);
}

resetRunDirectory();

const logFd = openSync(LOG_FILE, 'w');
const child = spawn(
  process.execPath,
  [
    join(REPO_ROOT, 'bin', 'cli.js'),
    'start',
    '--port',
    String(PORT),
    // The sandbox reaches the host over the Docker bridge, so bind beyond
    // loopback. The board is throwaway and isolated per run.
    '--host',
    '0.0.0.0',
  ],
  {
    cwd: DATA_DIR,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  },
);
closeSync(logFd);
child.unref();

let container;

function createSandbox(port) {
  const explicit = process.env.KB_PLAYWRIGHT_CONTAINER;
  if (explicit) {
    if (!dockerContainerRunning(explicit)) {
      throw new Error(
        `KB_PLAYWRIGHT_CONTAINER="${explicit}" is not a running container. Start it or unset the variable.`,
      );
    }

    return { name: explicit, image: undefined, owned: false };
  }

  if (!dockerImageExists(SANDBOX_IMAGE)) {
    throw new Error(
      `Playwright sandbox image "${SANDBOX_IMAGE}" is missing.\n` +
        '  Build one, or point KB_PLAYWRIGHT_IMAGE at an image that has Playwright installed and stays alive.',
    );
  }

  const name = `kanbrawl-verify-${port}-${Date.now().toString(36)}`;
  const created = docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'kanbrawl-verify=1',
    '--add-host=host.docker.internal:host-gateway',
    SANDBOX_IMAGE,
  ]);
  if (created.status !== 0) {
    throw new Error(`could not start sandbox container:\n${created.stderr.trim()}`);
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !dockerContainerRunning(name)) {
    const status = docker(['inspect', '-f', '{{.State.Status}}', name]);
    if (status.status === 0 && status.stdout.trim() === 'exited') {
      docker(['rm', '-f', name]);
      throw new Error(
        `sandbox container ${name} exited immediately; image "${SANDBOX_IMAGE}" must stay alive (e.g. sleep infinity)`,
      );
    }
  }

  if (!dockerContainerRunning(name)) {
    docker(['rm', '-f', name]);
    throw new Error(`sandbox container ${name} did not start within 10s`);
  }

  const hasPlaywright = docker([
    'exec',
    name,
    'test',
    '-f',
    `${CONTAINER_MODULE_ROOT}/node_modules/playwright/package.json`,
  ]);
  if (hasPlaywright.status !== 0) {
    docker(['rm', '-f', name]);
    throw new Error(
      `sandbox image "${SANDBOX_IMAGE}" has no Playwright under ${CONTAINER_MODULE_ROOT}/node_modules.\n` +
        '  Set KB_PW_ROOT to the directory that contains node_modules, or use another image.',
    );
  }

  return { name, image: SANDBOX_IMAGE, owned: true };
}

function removeSandbox(sandbox) {
  if (!sandbox?.owned) return;
  docker(['rm', '-f', sandbox.name]);
}

async function waitForReady(pid) {
  const deadline = Date.now() + 30_000;
  let lastError = 'no log output';
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      throw new Error(`server process exited early:\n${readLog()}`);
    }

    const match = readLog().match(/running on http:\/\/localhost:(\d+)/);
    if (match) {
      const port = Number(match[1]);
      try {
        const board = await fetchBoard(hostBaseUrl(port));
        return { port, board };
      } catch (error) {
        lastError = error.message;
      }
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });
  }

  throw new Error(`server did not become ready in 30s (${lastError})`);
}

try {
  const { port, board } = await waitForReady(child.pid);
  container = createSandbox(port);
  const instance = {
    pid: child.pid,
    port,
    hostUrl: hostBaseUrl(port),
    containerUrl: containerBaseUrl(port),
    dataDir: DATA_DIR,
    dataFile: join(DATA_DIR, 'kanbrawl.json'),
    logFile: LOG_FILE,
    container,
    startedAt: new Date().toISOString(),
  };
  writeInstance(instance);

  if (!existsSync(instance.dataFile)) {
    throw new Error(`board file was not created at ${instance.dataFile}`);
  }

  const names = board.columns.map((column) => column.name).join(', ');
  if (board.tasks.length > 0) {
    throw new Error(
      `fresh data directory loaded ${board.tasks.length} tasks - stale state`,
    );
  }

  ok(`Kanbrawl verify instance running on ${instance.hostUrl} (pid ${child.pid})`);
  ok(`Board file: ${instance.dataFile}`);
  ok(`Columns: ${names}`);
  ok(
    `${container.owned ? 'disposable' : 'reused'} sandbox: ${container.name}` +
      `${container.image ? ` (image ${container.image})` : ''}`,
  );
  console.log(`  Container URL: ${instance.containerUrl}`);
  console.log(`  Server log:    ${LOG_FILE}`);
} catch (error) {
  console.error(`✖ ${error.message}`);
  if (container) {
    removeSandbox(container);
    warn(`removed sandbox container ${container.name}`);
  }

  try {
    process.kill(child.pid);
  } catch {}

  process.exit(1);
}
