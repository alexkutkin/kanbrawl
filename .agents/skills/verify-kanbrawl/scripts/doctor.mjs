// Read-only health check: answers "is this verify instance worth driving?".
// Never mutates the board.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import {
  CONTAINER_ROOT,
  INSTANCE_FILE,
  SKILL_ROOT,
  docker,
  dockerContainerRunning,
  fail,
  fetchBoard,
  gatewayBaseUrl,
  isProcessAlive,
  listeningPids,
  ok,
  readInstance,
  warn,
  writeInstance,
} from './lib.mjs';

const instance = readInstance();
if (!instance) {
  fail(
    `No verify instance recorded at ${INSTANCE_FILE}.\n` +
      '  Run `node .agents/skills/verify-kanbrawl/scripts/launch.mjs` first.',
  );
}

let problems = 0;
function bad(message) {
  problems++;
  console.error(`✖ ${message}`);
}

if (!isProcessAlive(instance.pid)) {
  bad(`process ${instance.pid} is not running (stale instance record)`);
} else {
  ok(`process ${instance.pid} is alive`);
}

const owners = listeningPids(instance.port);
if (owners.length === 0) {
  bad(`nothing is listening on port ${instance.port}`);
} else if (!owners.includes(instance.pid)) {
  bad(
    `port ${instance.port} is owned by pid ${owners.join(', ')}, not ${instance.pid}`,
  );
} else {
  ok(`port ${instance.port} is owned by our pid`);
}

let board;
try {
  board = await fetchBoard(instance.hostUrl);
  ok(`GET ${instance.hostUrl}/api/board -> 200`);
} catch (error) {
  bad(`board API unreachable: ${error.message}`);
}

if (board) {
  if (!existsSync(instance.dataFile)) {
    bad(`board database missing: ${instance.dataFile}`);
  } else {
    const database = new DatabaseSync(instance.dataFile);
    let storedIds = '';
    try {
      storedIds = database
        .prepare('SELECT id FROM tasks')
        .all()
        .map((row) => row.id)
        .sort()
        .join(',');
    } finally {
      database.close();
    }

    const servedIds = board.tasks.map((task) => task.id).sort().join(',');
    if (storedIds !== servedIds) {
      bad(
        `served tasks differ from ${instance.dataFile} - this instance is not using the recorded data directory`,
      );
    } else {
      ok(
        `board database matches the API (${board.tasks.length} tasks, ${board.columns.length} columns)`,
      );
    }
  }
}

const containerName = instance.container?.name;
if (!containerName) {
  bad(
    'the instance record has no Playwright sandbox. Run cleanup.mjs, then launch.mjs again.',
  );
} else if (!dockerContainerRunning(containerName)) {
  bad(
    `Playwright sandbox container "${containerName}" is not running.\n` +
      '  Run cleanup.mjs, then launch.mjs again to create a fresh one.',
  );
} else {
  ok(
    `Playwright sandbox container "${containerName}" is running` +
      `${instance.container.owned ? ' (disposable)' : ' (reused)'}`,
  );
}

if (!containerName) {
  process.exit(1);
}

const probe = join(SKILL_ROOT, 'scripts', 'probe-url.mjs');
docker(['exec', containerName, 'mkdir', '-p', CONTAINER_ROOT]);
const copied = docker([
  'cp',
  probe,
  `${containerName}:${CONTAINER_ROOT}/probe-url.mjs`,
]);
if (copied.status !== 0) {
  bad(`could not copy the URL probe into ${containerName}: ${copied.stderr}`);
} else {
  let reachable;
  for (const url of [instance.containerUrl, gatewayBaseUrl(instance.port)]) {
    const result = docker([
      'exec',
      containerName,
      'node',
      `${CONTAINER_ROOT}/probe-url.mjs`,
      url,
    ]);
    const output = (result.stdout ?? '').trim();
    if (result.status === 0 && output.startsWith('OK')) {
      reachable = url;
      break;
    }
  }

  if (!reachable) {
    bad(
      `the sandbox cannot reach the verify instance at ${instance.containerUrl} or ${gatewayBaseUrl(instance.port)}`,
    );
  } else {
    ok(`sandbox reaches the board at ${reachable}`);
    if (reachable !== instance.containerUrl) {
      warn(`recording ${reachable} as the container URL`);
      writeInstance({ ...instance, containerUrl: reachable });
    }
  }
}

if (problems > 0) {
  console.error(`\n✖ ${problems} problem(s). Do not trust this instance.`);
  process.exit(1);
}

ok('instance is healthy and ready to drive');
console.log(`  Drive it: node .agents/skills/verify-kanbrawl/scripts/drive.mjs <feature>`);
