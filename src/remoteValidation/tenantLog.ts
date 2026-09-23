import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  closeSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

// → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs

const TAIL_LINES = 200;
const TAIL_BYTES = 64 * 1024;
const LOG_CAP_BYTES = 2 * 1024 * 1024;
const KEEP_PER_ENVIRONMENT = 5;
const HEARTBEAT_MS = 5_000;
const HEARTBEAT_STALE_MS = 60_000;
const HEAD_CHARS = 4096;

const OUTPUT_FILE = 'output.log';
const EXIT_FILE = 'exit.json';
const HEARTBEAT_FILE = 'heartbeat';

/** What the runner writes when the command ends, and the only thing an outcome is read from. */
export interface TenantExit {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  stdoutHead: string;
  stderrHead: string;
}

export interface TenantTail {
  lines: string[];
  /** When the command last wrote anything. Null before it has. */
  lastOutputAt: string | null;
}

/**
 * The runner: a Node process the harness starts detached, which starts the project's command and tees
 * its output to a file the harness owns. Plain CommonJS handed to `node -e`, so it needs no build and
 * no path on disk to exist.
 */
const RUNNER = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const spec = JSON.parse(process.argv[1]);
const log = path.join(spec.dir, ${JSON.stringify(OUTPUT_FILE)});
let fd = fs.openSync(log, 'a');
let size = fs.fstatSync(fd).size;
function write(buf) {
  if (size + buf.length > spec.logCapBytes) {
    fs.closeSync(fd);
    try { fs.renameSync(log, log + '.1'); } catch {}
    fd = fs.openSync(log, 'a');
    size = 0;
  }
  fs.writeSync(fd, buf);
  size += buf.length;
}
const beat = () => { try { fs.writeFileSync(path.join(spec.dir, ${JSON.stringify(HEARTBEAT_FILE)}), String(process.pid)); } catch {} };
beat();
const heart = setInterval(beat, spec.heartbeatMs);
let out = '';
let err = '';
let timedOut = false;
let failed = null;
const child = spawn(spec.command, {
  shell: true,
  cwd: spec.cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
  detached: process.platform !== 'win32',
});
child.stdout.on('data', (b) => { write(b); if (out.length < ${String(HEAD_CHARS)}) out += b.toString('utf8'); });
child.stderr.on('data', (b) => { write(b); if (err.length < ${String(HEAD_CHARS)}) err += b.toString('utf8'); });
function kill() {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref();
}
const timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);
process.on('SIGTERM', kill);
process.on('SIGINT', kill);
let done = false;
function finish(code, signal) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  clearInterval(heart);
  const exit = path.join(spec.dir, ${JSON.stringify(EXIT_FILE)});
  fs.writeFileSync(exit + '.tmp', JSON.stringify({
    code, signal, timedOut, error: failed,
    stdoutHead: out.slice(0, ${String(HEAD_CHARS)}), stderrHead: err.slice(0, ${String(HEAD_CHARS)}),
  }));
  fs.renameSync(exit + '.tmp', exit);
  try { fs.closeSync(fd); } catch {}
  process.exit(0);
}
child.on('error', (e) => { failed = e.message; finish(null, null); });
child.on('exit', (code, signal) => {
  let closed = false;
  child.on('close', () => { closed = true; finish(code, signal); });
  setTimeout(() => { if (!closed) finish(code, signal); }, 2000);
});
`;

function safeName(environment: string): string {
  return environment.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
}

export function launchDir(root: string, environment: string, id: string): string {
  return join(root, safeName(environment), safeName(id));
}

/** Sortable by time, so the sweep keeps the newest by name. */
function launchId(now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

export function startRunner(input: {
  root: string;
  environment: string;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  now: number;
}): { id: string; dir: string; pid: number | null; exited: Promise<void> } {
  const id = launchId(input.now);
  const dir = launchDir(input.root, input.environment, id);
  mkdirSync(dir, { recursive: true });
  const spec = {
    dir,
    command: input.command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    heartbeatMs: HEARTBEAT_MS,
    logCapBytes: LOG_CAP_BYTES,
  };
  const child = spawn(process.execPath, ['--input-type=commonjs', '-e', RUNNER, JSON.stringify(spec)], {
    cwd: input.cwd,
    env: input.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
  sweep(input.root, input.environment, id);
  return { id, dir, pid: child.pid ?? null, exited };
}

export function readExit(dir: string): TenantExit | null {
  const path = join(dir, EXIT_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TenantExit;
  } catch {
    // A torn read is impossible (the runner renames into place); an unreadable one is no outcome.
    return null;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is the runner behind this launch still going? The pid alone is not enough — a pid is reused — so
 * the runner's own heartbeat has to be fresh too, and nothing but that runner writes it.
 */
export function runnerAlive(dir: string, pid: number | null, now: number): boolean {
  if (pid === null || !pidAlive(pid)) return false;
  try {
    return now - statSync(join(dir, HEARTBEAT_FILE)).mtimeMs < HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

function tailOf(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = statSync(path).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map(
      (line) =>
        line
          .split('\r')
          .filter((part) => part !== '')
          .at(-1) ?? '',
    )
    .filter((line) => line.trim() !== '');
}

export function readTail(dir: string): TenantTail {
  const current = join(dir, OUTPUT_FILE);
  let lines = linesOf(tailOf(current));
  if (lines.length < TAIL_LINES) lines = [...linesOf(tailOf(`${current}.1`)), ...lines];
  let lastOutputAt: string | null = null;
  try {
    const stat = statSync(current);
    if (stat.size > 0) lastOutputAt = stat.mtime.toISOString();
  } catch {
    lastOutputAt = null;
  }
  return { lines: lines.slice(-TAIL_LINES), lastOutputAt };
}

/** Keeps the newest few launches per environment, and never one whose runner is still beating. */
function sweep(root: string, environment: string, keep: string): void {
  const envDir = join(root, safeName(environment));
  let names: string[];
  try {
    names = readdirSync(envDir).sort();
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_PER_ENVIRONMENT))) {
    if (name === safeName(keep)) continue;
    const dir = join(envDir, name);
    try {
      if (now - statSync(join(dir, HEARTBEAT_FILE)).mtimeMs < HEARTBEAT_STALE_MS && readExit(dir) === null) continue;
    } catch {
      // no heartbeat: nothing is running there
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
