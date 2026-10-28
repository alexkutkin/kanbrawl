// Shared paths and process helpers for the Kanbrawl verification harness.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const SKILL_ROOT = resolve(scriptDirectory, '..');
export const REPO_ROOT = resolve(scriptDirectory, '../../../..');
export const VERIFY_ROOT = join(REPO_ROOT, '.verify');
export const RUN_ROOT = join(VERIFY_ROOT, 'run');
export const DATA_DIR = join(RUN_ROOT, 'data');
export const LOG_FILE = join(RUN_ROOT, 'server.log');
export const INSTANCE_FILE = join(RUN_ROOT, 'instance.json');
export const EVIDENCE_ROOT = join(VERIFY_ROOT, 'evidence');

// The sandbox runs Playwright with Chromium, so verification never opens a
// window on the host desktop. By default the harness creates a disposable
// container per launch; set KB_PLAYWRIGHT_CONTAINER to reuse one instead.
export const SANDBOX_IMAGE =
  process.env.KB_PLAYWRIGHT_IMAGE ?? 'playwright-sandbox';
export const CONTAINER_ROOT = '/tmp/kb-verify';
export const CONTAINER_MODULE_ROOT = process.env.KB_PW_ROOT ?? '/app';
export const PORT = Number(process.env.KB_VERIFY_PORT ?? 8473);

export function hostBaseUrl(port = PORT) {
  return `http://127.0.0.1:${port}`;
}

export function containerBaseUrl(port = PORT) {
  return `http://host.docker.internal:${port}`;
}

export function gatewayBaseUrl(port = PORT) {
  return `http://172.17.0.1:${port}`;
}

export function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

export function docker(args, options = {}) {
  return runCommand('docker', args, options);
}

export function dockerContainerRunning(name) {
  if (!name) return false;
  const result = docker(['inspect', '-f', '{{.State.Running}}', name]);
  return result.status === 0 && result.stdout.trim() === 'true';
}

export function dockerImageExists(image) {
  return docker(['image', 'inspect', image]).status === 0;
}

export function readInstance() {
  if (!existsSync(INSTANCE_FILE)) return undefined;
  return JSON.parse(readFileSync(INSTANCE_FILE, 'utf8'));
}

export function writeInstance(instance) {
  mkdirSync(RUN_ROOT, { recursive: true });
  writeFileSync(INSTANCE_FILE, JSON.stringify(instance, null, 2) + '\n');
}

export function readLog() {
  return existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function listeningPids(port) {
  if (process.platform === 'win32') {
    const result = runCommand('netstat', ['-ano', '-p', 'tcp'], {
      windowsHide: true,
    });
    const pids = new Set();
    for (const line of result.stdout.split(/\r?\n/)) {
      const match = line.match(new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
      if (match) pids.add(Number(match[1]));
    }

    return [...pids];
  }

  const result = runCommand('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]);
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number(value));
}

export async function fetchBoard(baseUrl) {
  const response = await fetch(`${baseUrl}/api/board`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`GET /api/board -> ${response.status}`);
  return response.json();
}

export function resetRunDirectory() {
  rmSync(RUN_ROOT, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
}

export function fail(message) {
  console.error(`✖ ${message}`);
  process.exit(1);
}

export function ok(message) {
  console.log(`✔ ${message}`);
}

export function warn(message) {
  console.log(`! ${message}`);
}
