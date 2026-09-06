import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import type { ErrorRecorder } from '../errorLog.js';

// → docs/spec/23-local-runs.md

const exec = promisify(execFile);

export interface PortOwner {
  pid: number | null;
  dir: string;
}

export interface PortLister {
  listening(run: PortOwner): Promise<number[] | null>;
}

interface ProcessRow {
  pid: number;
  ppid: number;
  args: string;
}

interface ListeningRow {
  port: number;
  pid: number;
}

export function owners(run: PortOwner, rows: readonly ProcessRow[]): Set<number> {
  const held = new Set<number>();
  for (const row of rows) if (startedIn(row.args, run.dir)) held.add(row.pid);
  if (run.pid !== null) for (const pid of descendants(run.pid, rows)) held.add(pid);
  return held;
}

export function startedIn(args: string, dir: string): boolean {
  if (dir === '') return false;
  const needle = normalisePath(dir);
  const haystack = normalisePath(args);
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    const after = haystack[at + needle.length];
    if (after === undefined || after === '/') return true;
    at = haystack.indexOf(needle, at + 1);
  }
  return false;
}

function normalisePath(text: string): string {
  return text.split('\\').join('/').replace(/\/+$/, '').toLowerCase();
}

export function descendants(rootPid: number, rows: readonly ProcessRow[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

export function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (answering: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answering);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

const COMMAND_TIMEOUT_MS = 8_000;

export class CommandPortLister implements PortLister {
  private lastFailure: string | null = null;

  constructor(private readonly errors?: ErrorRecorder) {}

  async listening(run: PortOwner): Promise<number[] | null> {
    try {
      const [sockets, table] = process.platform === 'win32' ? await windowsTables() : await posixTables();
      const mine = owners(run, table);
      const held = new Set<number>();
      for (const row of sockets) if (mine.has(row.pid)) held.add(row.port);
      this.lastFailure = null;
      return [...held].sort((a, b) => a - b);
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastFailure) {
        this.lastFailure = message;
        this.errors?.record({ source: 'agent', message: `Could not list the local run's listening ports: ${message}` });
      }
      return null;
    }
  }
}

async function run(command: string, args: string[]): Promise<string> {
  const { stdout } = await exec(command, args, {
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

const WIN_SOCKETS = 'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess';
const WIN_PROCESSES = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine';

async function windowsTables(): Promise<[ListeningRow[], ProcessRow[]]> {
  const [sockets, processes] = await Promise.all([powershell(WIN_SOCKETS), powershell(WIN_PROCESSES)]);
  return [
    asRows(sockets).flatMap((row) => {
      const port = integerOf(row, 'LocalPort');
      const pid = integerOf(row, 'OwningProcess');
      return port === null || pid === null ? [] : [{ port, pid }];
    }),
    asRows(processes).flatMap((row) => {
      const pid = integerOf(row, 'ProcessId');
      const ppid = integerOf(row, 'ParentProcessId');
      const args = row.CommandLine;
      return pid === null || ppid === null ? [] : [{ pid, ppid, args: typeof args === 'string' ? args : '' }];
    }),
  ];
}

async function powershell(select: string): Promise<unknown> {
  const script = `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${select} | ConvertTo-Json -Compress)))`;
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const encoded = out.replace(/\s+/g, '');
  if (encoded === '') return [];
  const json = Buffer.from(encoded, 'base64').toString('utf8').trim();
  return json === '' || json === 'null' ? [] : (JSON.parse(json) as unknown);
}

function asRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function integerOf(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

async function posixTables(): Promise<[ListeningRow[], ProcessRow[]]> {
  const [sockets, ps] = await Promise.all([posixSockets(), run('ps', ['-eo', 'pid=,ppid=,args='])]);
  return [sockets, parsePs(ps)];
}

export function parsePs(out: string): ProcessRow[] {
  const table: ProcessRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) table.push({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' });
  }
  return table;
}

async function posixSockets(): Promise<ListeningRow[]> {
  try {
    return parseSs(await run('ss', ['-ltnpH']));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return parseLsof(await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pn']));
  }
}

export function parseSs(out: string): ListeningRow[] {
  const rows: ListeningRow[] = [];
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    const port = portOf(cols[3] ?? '');
    if (port === null) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) rows.push({ port, pid: Number(m[1]) });
  }
  return rows;
}

export function parseLsof(out: string): ListeningRow[] {
  const rows: ListeningRow[] = [];
  let pid: number | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) {
      const port = portOf(line.slice(1));
      if (port !== null) rows.push({ port, pid });
    }
  }
  return rows;
}

function portOf(address: string): number | null {
  const at = address.lastIndexOf(':');
  if (at < 0) return null;
  const port = Number(address.slice(at + 1));
  return Number.isInteger(port) && port > 0 ? port : null;
}
