import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import type { ErrorRecorder } from '../errorLog.js';

const exec = promisify(execFile);

/** Which run's ports to look for: the session holding it, and the checkout it runs in. */
export interface PortOwner {
  /** The session process, or null when nothing in this harness holds one. */
  pid: number | null;
  /** `LocalRun.dir` — the checkout every one of this run's processes was launched from. */
  dir: string;
}

/**
 * Which TCP ports a local run is listening on.
 *
 * A seam for the reaper's reason (`src/agents/processTree.ts`): the real one shells
 * out to the OS, and the fake transports mint pids that belong to other people's
 * processes — so under a fake it must not run at all, and `system.ts` defaults it to
 * {@link FakePortLister} there.
 *
 * `null` is "could not say" — the command is missing, timed out or printed something
 * unreadable — and is never folded into an empty list, which would read as "nothing
 * is listening". Containers never appear: a mapped port belongs to the daemon, not
 * to anything the session started.
 * → `docs/spec/23-local-runs.md#watching-the-environment`
 */
export interface PortLister {
  listening(run: PortOwner): Promise<number[] | null>;
}

/** One row of the process table: a pid, the pid that started it, and how it was started. */
interface ProcessRow {
  pid: number;
  ppid: number;
  /** The full command line, or '' where the OS would not say (a protected process). */
  args: string;
}

/** One listening socket and the process that holds it. */
interface ListeningRow {
  port: number;
  pid: number;
}

/**
 * Which pids belong to the run: anything launched **from its checkout**, plus
 * anything under the session holding it.
 *
 * **The path is the primary rule, and the subtree is the backstop** — which is the
 * opposite of what this started as, for a reason worth stating. A local run's
 * processes are not reliably its descendants: an instruction that launches each
 * service in its own shell leaves that shell free to exit, and Windows does not
 * reparent an orphan — the child's recorded parent stays a pid that no longer
 * exists. Measured against the NXG stack, **all six** of its services had a dead
 * parent, so a walk from the session's pid reached none of them and the reading was
 * empty on exactly the deployment it was built for.
 *
 * A command line naming the checkout survives all of that, and is what the operator's
 * own runbook already uses to tell one worktree's stack from another's. It is also
 * the sharper reading: two checkouts of the same project on one laptop hold different
 * ports, and this attributes each to its own run rather than to whichever session is
 * an ancestor.
 *
 * The subtree stays because it costs one field of a table already being read, and
 * catches a process whose argv does not happen to name the path.
 *
 * Pure, so both rules are tested without a process table. Cycle-safe, because a
 * table read in two commands is not a snapshot: a pid reused between the reads can
 * point a process at its own descendant.
 */
export function owners(run: PortOwner, rows: readonly ProcessRow[]): Set<number> {
  const held = new Set<number>();
  for (const row of rows) if (startedIn(row.args, run.dir)) held.add(row.pid);
  if (run.pid !== null) for (const pid of descendants(run.pid, rows)) held.add(pid);
  return held;
}

/**
 * Whether a command line refers to something inside `dir`.
 *
 * Case-insensitive and separator-agnostic, because a Windows command line quotes
 * backslashes and `path.resolve` may not agree with the shell about which slash a
 * path was written with. The directory must be followed by a separator or end there,
 * so a run in `…/local-run` does not claim the ports of one in `…/local-run-2`.
 */
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

/**
 * The pids under `rootPid`, root included, walked through `ppid` links. The backstop
 * half of {@link owners}.
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
 * owning pids, and the process table with each process's command line — joined by
 * {@link owners}.
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
// CommandLine is the half that attributes a port, and it is null for a process this
// session may not read — a `Select-Object` of three fields keeps that a blank rather
// than a failure.
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

/**
 * Run `script` and read back what it selected, **base64 over the wire**.
 *
 * The JSON is exact by the time it reaches `ConvertTo-Json`: that cmdlet escapes
 * every C0 character, including the ones a command line can carry, so a payload
 * this refuses was corrupted on its way through stdout rather than built wrong.
 * That is what an operator hit — `Bad control character in string literal ... at
 * position 77337`, on a table PowerShell had serialised correctly — and it is a
 * class of failure worth removing rather than diagnosing: what a console does to a
 * 150KB line depends on the code page, the host and the redirection, and none of
 * those is the harness's to pin down.
 *
 * Base64 is plain ASCII, so nothing between here and there has a byte it can
 * mistranslate. The cost is a third again in payload, on a reading taken once every
 * ten seconds while a run is up.
 */
async function powershell(select: string): Promise<unknown> {
  const script = `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${select} | ConvertTo-Json -Compress)))`;
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  // Every newline taken out rather than left to the decoder: `Buffer.from` skips
  // whitespace itself, and a payload that is only correct because of that is one
  // wrapped line away from being silently half-read.
  const encoded = out.replace(/\s+/g, '');
  if (encoded === '') return [];
  const json = Buffer.from(encoded, 'base64').toString('utf8').trim();
  // `ConvertTo-Json` of nothing at all is an empty string, and of one `$null` is
  // `null` — neither is a table, and both mean the same thing here.
  return json === '' || json === 'null' ? [] : (JSON.parse(json) as unknown);
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
  const [sockets, ps] = await Promise.all([posixSockets(), run('ps', ['-eo', 'pid=,ppid=,args='])]);
  return [sockets, parsePs(ps)];
}

/** `ps -eo pid=,ppid=,args=`: two numbers, then the command line to end of line. */
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
