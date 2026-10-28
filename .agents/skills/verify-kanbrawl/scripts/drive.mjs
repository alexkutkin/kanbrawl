// Drives one mapped feature of the running verify instance.
// Copies the Playwright runner into the sandbox container, executes it there
// (headless, no host browser window), and copies evidence back into the repo.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import {
  CONTAINER_MODULE_ROOT,
  CONTAINER_ROOT,
  EVIDENCE_ROOT,
  INSTANCE_FILE,
  SKILL_ROOT,
  docker,
  dockerContainerRunning,
  fail,
  fetchBoard,
  isProcessAlive,
  ok,
  readInstance,
  warn,
} from './lib.mjs';

const feature = process.argv[2];
if (!feature) {
  fail(
    'usage: node .agents/skills/verify-kanbrawl/scripts/drive.mjs <feature>\n' +
      '  features: board | tasks | drag-drop | task-detail | columns | attachments',
  );
}

const instance = readInstance();
if (!instance) {
  fail(
    `No verify instance recorded at ${INSTANCE_FILE}.\n` +
      '  Run `node .agents/skills/verify-kanbrawl/scripts/launch.mjs` first.',
  );
}

if (!isProcessAlive(instance.pid)) {
  fail(`process ${instance.pid} is not running. Run launch.mjs again.`);
}

const containerName = instance.container?.name;
if (!containerName || !dockerContainerRunning(containerName)) {
  fail(
    'the Playwright sandbox for this instance is not running.\n' +
      '  Run cleanup.mjs, then launch.mjs again (launch creates a disposable sandbox).',
  );
}

const runId = new Date()
  .toISOString()
  .replace(/\.\d+Z$/, '')
  .replace(/[:T]/g, '-');
const evidenceName = `${runId}-${feature}`;
const evidenceDir = join(EVIDENCE_ROOT, evidenceName);
const containerRunDir = `${CONTAINER_ROOT}/${evidenceName}`;
mkdirSync(evidenceDir, { recursive: true });

const runnerSource = join(SKILL_ROOT, 'scripts', 'runner.mjs');
docker(['exec', containerName, 'mkdir', '-p', containerRunDir]);
const copyIn = docker(['cp', runnerSource, `${containerName}:${containerRunDir}/runner.mjs`]);
if (copyIn.status !== 0) {
  fail(`could not copy the runner into ${containerName}: ${copyIn.stderr}`);
}

console.log(`▶ ${feature} against ${instance.hostUrl}`);
console.log(`  evidence: ${evidenceDir}`);

const exec = docker(
  [
    'exec',
    '-e',
    `KB_BASE_URL=${instance.containerUrl}`,
    '-e',
    `KB_FEATURE=${feature}`,
    '-e',
    `KB_OUT=${containerRunDir}`,
    '-e',
    `KB_PW_ROOT=${CONTAINER_MODULE_ROOT}`,
    containerName,
    'node',
    `${containerRunDir}/runner.mjs`,
  ],
  { stdio: 'inherit' },
);

const copyOut = docker([
  'cp',
  `${containerName}:${containerRunDir}/.`,
  evidenceDir,
]);
if (copyOut.status !== 0) {
  warn(`could not copy evidence out of ${containerName}: ${copyOut.stderr}`);
}

const reportFile = join(evidenceDir, 'report.json');
if (!existsSync(reportFile)) {
  fail(
    `no report.json was produced; evidence directory: ${evidenceDir}\n` +
      `  runner exit code: ${exec.status}`,
  );
}

// Host-side proof that what the browser showed is also on disk.
const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const stored = readStoredBoard(instance.dataFile);
let board;
try {
  board = await fetchBoard(instance.hostUrl);
} catch (error) {
  fail(`board API unreachable after the run: ${error.message}`);
}

const hostChecks = [];
function hostCheck(name, condition, detail) {
  hostChecks.push({ name, ok: Boolean(condition), detail });
  if (condition) {
    ok(name);
  } else {
    console.error(`✖ ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function readStoredBoard(dataFile) {
  const database = new DatabaseSync(dataFile);
  try {
    return {
      columns: database
        .prepare('SELECT name FROM columns ORDER BY position')
        .all()
        .map((row) => ({ name: row.name })),
      tasks: database
        .prepare('SELECT id, column_name FROM tasks')
        .all()
        .map((row) => ({ id: row.id, column: row.column_name })),
      attachments: database
        .prepare('SELECT id, task_id FROM attachments')
        .all()
        .map((row) => ({ id: row.id, taskId: row.task_id })),
    };
  } finally {
    database.close();
  }
}

const servedIds = board.tasks.map((task) => task.id).sort().join(',');
const storedIds = stored.tasks.map((task) => task.id).sort().join(',');
hostCheck(
  'served board matches kanbrawl.db task ids',
  servedIds === storedIds,
  servedIds === storedIds ? undefined : 'served and stored task ids differ',
);
hostCheck(
  'served columns match kanbrawl.db',
  board.columns.map((column) => column.name).join('|') ===
    stored.columns.map((column) => column.name).join('|'),
);
const storedById = new Map(stored.tasks.map((task) => [task.id, task]));
hostCheck(
  'every task column persisted to kanbrawl.db',
  board.tasks.every((task) => storedById.get(task.id)?.column === task.column),
);
const servedAttachments = board.tasks
  .flatMap((task) => (task.attachments ?? []).map((item) => item.id))
  .sort()
  .join(',');
const storedAttachments = stored.attachments
  .map((item) => item.id)
  .sort()
  .join(',');
hostCheck(
  'served attachments match kanbrawl.db',
  servedAttachments === storedAttachments,
  servedAttachments === storedAttachments
    ? undefined
    : 'served and stored attachment ids differ',
);
hostCheck(
  'kanbrawl.db holds columns, tasks and attachments tables',
  Array.isArray(stored.tasks) &&
    Array.isArray(stored.columns) &&
    Array.isArray(stored.attachments),
);

report.hostChecks = hostChecks;
report.evidenceDir = evidenceDir;
report.ok = Boolean(report.ok) && hostChecks.every((check) => check.ok);
writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');

const screenshots = report.shots ?? [];
console.log(`\nEvidence (${screenshots.length} screenshots + report.json):`);
console.log(`  ${evidenceDir}`);
if (screenshots.length > 0) {
  for (const file of screenshots) console.log(`  - ${file}`);
}

if (exec.status !== 0 || !report.ok) {
  process.exit(1);
}

ok(`${feature} verified`);
