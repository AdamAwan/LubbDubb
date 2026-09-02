import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import type { ErrorRecorder } from '../errorLog.js';

const exec = promisify(execFile);

/**
 * Which TCP ports the local run's own process tree is listening on.
 *
 * A seam for the reaper's reason (`src/agents/processTree.ts`): the real one shells
 * out to the OS and walks parent-pid links from a pid, and the fake transports mint
 * pids that belong to other people's processes on the host — so under a fake it must
 * not run at all, and `system.ts` defaults it to {@link FakePortLister} there.
 *
 * `null` is "could not say" — the command is missing, timed out or printed something
 * unreadable — and is never folded into an empty list, which would read as "nothing
 * is listening". Containers never appear here: a mapped port belongs to the daemon,
 * not to anything the session started.
 * → `docs/spec/23-local-runs.md#watching-the-environment`
 */
export interface PortLister {
  listening(rootPid: number): Promise<number[] | null>;
}

/** One row of the process table: a pid and the pid that started it. */
interface ProcessRow {
  pid: number;
  ppid: number;
}

/** One listening socket and the process that holds it. */
interface ListeningRow {
  port: number;
  pid: number;
}

/**
 * The pids under `rootPid`, root included, walked through `ppid` links.
 *
 * Pure, so the walk is tested without a process table. Cycle-safe, because a table
 * read in two commands is not a snapshot: a pid reused between the reads can point
 * a process at its own descendant.
 */
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

/**
 * Whether something accepts a TCP connection on `host:port` within `timeoutMs`.
 *
 * A connect and a close, nothing sent: the question is "is the port held", and an
 * HTTP request would be a claim about the application that nothing here is placed
 * to make. False on refusal *and* on timeout — a port that does not answer in a
 * second is not answering, whatever the reason. Never rejects.
 */
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

/** How long either command may run before it is killed. The kill answers null. */
const COMMAND_TIMEOUT_MS = 8_000;

/**
 * The real lister: two commands per reading — the listening sockets with their
 * owning pids, and the process table — joined by {@link descendants}.
 *
 * Two platforms, two pairs, because Windows has no `ss`: PowerShell's
 * `Get-NetTCPConnection` and `Win32_Process` there, `ss -ltnp` and `ps` on POSIX,
 * with `lsof` behind `ss` for a machine without iproute2. Every failure is `null`
 * plus one recorded error per distinct message — `PlanReconciler.maybeFetch`'s
 * rule, so a machine without the command does not fill the Errors panel every
 * ten seconds.
 */
export class CommandPortLister implements PortLister {
  private lastFailure: string | null = null;

  constructor(private readonly errors?: ErrorRecorder) {}

  async listening(rootPid: number): Promise<number[] | null> {
    try {
      const [sockets, table] = process.platform === 'win32' ? await windowsTables() : await posixTables();
      const mine = descendants(rootPid, table);
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
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

const WIN_SOCKETS =
  'Get-NetTCPConnection -State Listen | Select-Object LocalPort,OwningProcess | ConvertTo-Json -Compress';
const WIN_PROCESSES =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';

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
      return pid === null || ppid === null ? [] : [{ pid, ppid }];
    }),
  ];
}

async function powershell(script: string): Promise<unknown> {
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  return out.trim() === '' ? [] : (JSON.parse(out) as unknown);
}

/** `ConvertTo-Json` prints one row as a bare object rather than a one-element array. */
function asRows(value: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function integerOf(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

async function posixTables(): Promise<[ListeningRow[], ProcessRow[]]> {
  const [sockets, ps] = await Promise.all([posixSockets(), run('ps', ['-eo', 'pid=,ppid='])]);
  const table: ProcessRow[] = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.push({ pid: Number(m[1]), ppid: Number(m[2]) });
  }
  return [sockets, table];
}

async function posixSockets(): Promise<ListeningRow[]> {
  try {
    return parseSs(await run('ss', ['-ltnpH']));
  } catch (err) {
    // No `ss` at all — a Mac — is the one failure worth a second command. Anything
    // else is the real answer to "could not say".
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return parseLsof(await run('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pn']));
  }
}

/**
 * `ss -ltnpH`: one socket per line, the local address in the fourth column and
 * every holder in a trailing `users:(("node",pid=123,fd=22),...)`.
 */
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

/** `lsof -F pn`: a `p<pid>` line, then one `n<address>` line per socket that pid holds. */
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

/** The port off the end of `host:port`, `[::1]:port` or `*:port`; null where there is none. */
function portOf(address: string): number | null {
  const at = address.lastIndexOf(':');
  if (at < 0) return null;
  const port = Number(address.slice(at + 1));
  return Number.isInteger(port) && port > 0 ? port : null;
}
