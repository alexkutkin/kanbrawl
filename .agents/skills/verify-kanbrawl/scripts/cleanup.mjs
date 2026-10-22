// Stops the verify instance this harness started and removes scratch state.
// Evidence in `.verify/evidence/` is never deleted.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import process from 'node:process';
import {
  CONTAINER_ROOT,
  EVIDENCE_ROOT,
  INSTANCE_FILE,
  RUN_ROOT,
  docker,
  dockerContainerRunning,
  isProcessAlive,
  listeningPids,
  ok,
  readInstance,
  warn,
} from './lib.mjs';

const instance = readInstance();

if (instance && isProcessAlive(instance.pid)) {
  console.log(`Stopping verify instance (pid ${instance.pid}, port ${instance.port})...`);
  try {
    process.kill(instance.pid);
  } catch (error) {
    warn(`could not signal pid ${instance.pid}: ${error.message}`);
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(instance.pid)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  if (isProcessAlive(instance.pid)) {
    warn(`pid ${instance.pid} is still running - stop it manually`);
  } else {
    ok(`pid ${instance.pid} stopped`);
  }
} else if (instance) {
  ok(`pid ${instance.pid} was already stopped`);
} else {
  ok('no verify instance was recorded');
}

if (instance) {
  const owners = listeningPids(instance.port);
  if (owners.length === 0) {
    ok(`port ${instance.port} is free`);
  } else {
    warn(
      `port ${instance.port} is still listening (pid ${owners.join(', ')}) - not ours, left alone`,
    );
  }
}

rmSync(RUN_ROOT, { recursive: true, force: true });
ok(`removed scratch state under ${RUN_ROOT}`);

if (existsSync(INSTANCE_FILE)) {
  warn(`could not remove ${INSTANCE_FILE}`);
}

const containerName = instance?.container?.name;
if (!containerName) {
  ok('no sandbox container was recorded');
} else if (instance.container.owned) {
  const removed = docker(['rm', '-f', containerName]);
  if (removed.status === 0) {
    ok(`removed disposable sandbox ${containerName}`);
  } else {
    warn(`could not remove sandbox ${containerName}: ${removed.stderr.trim()}`);
  }
} else if (dockerContainerRunning(containerName)) {
  const cleared = docker(['exec', containerName, 'rm', '-rf', CONTAINER_ROOT]);
  if (cleared.status === 0) {
    ok(`removed ${CONTAINER_ROOT} inside reused sandbox ${containerName}`);
  } else {
    warn(`could not clear ${CONTAINER_ROOT} inside ${containerName}: ${cleared.stderr}`);
  }
} else {
  warn(`reused sandbox "${containerName}" is not running - nothing to clear`);
}

if (existsSync(EVIDENCE_ROOT)) {
  const runs = readdirSync(EVIDENCE_ROOT);
  console.log(`✔ evidence kept: ${EVIDENCE_ROOT} (${runs.length} run(s))`);
} else {
  console.log('  no evidence was captured');
}
