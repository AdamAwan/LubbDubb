import { execFile } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { killProcessTree } from '../agents/processTree.js';

// → docs/spec/09-execution.md#a-process-left-standing-in-a-slot

/**
 * A live process holding something inside a slot directory.
 *
 * @public read back by the worktree pool, which names them in the fault it raises
 */
export interface SlotProcess {
  pid: number;
  parentPid: number;
  detail: string;
}

export interface SlotProcesses {
  /** The processes holding `dir`, or `null` where the probe itself could not say. */
  holding(dir: string): Promise<SlotProcess[] | null>;
  stop(held: SlotProcess[]): Promise<void>;
}

export class CommandSlotProcesses implements SlotProcesses {
  constructor(private readonly onWarning?: (message: string) => void) {}

  async holding(dir: string): Promise<SlotProcess[] | null> {
    const root = resolve(dir);
    try {
      const walk = process.platform === 'win32' ? await mapped(root) : await occupying(root);
      const found = walk.held.filter((p) => !ours(walk.held, p.pid));
      if (walk.complete) return found;
      this.onWarning?.(partialWalk(root, found.length));
      return found.length === 0 ? null : found;
    } catch (err) {
      this.onWarning?.(`Could not list the processes holding ${root}: ${probeFailure(err)}`);
      return null;
    }
  }

  stop(held: SlotProcess[]): Promise<void> {
    for (const p of childrenFirst(held)) killProcessTree(p.pid, this.onWarning);
    return Promise.resolve();
  }
}

/**
 * Depth-first order over the parent links inside the set, so a parent is never signalled while a
 * child of it is still waiting to be signalled.
 *
 * @public the pool's sweep and its tests read the order back
 */
export function childrenFirst(held: SlotProcess[]): SlotProcess[] {
  const byPid = new Map(held.map((p) => [p.pid, p]));
  const depth = (p: SlotProcess): number => {
    let n = 0;
    const seen = new Set([p.pid]);
    let cur = byPid.get(p.parentPid);
    while (cur !== undefined && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      n += 1;
      cur = byPid.get(cur.parentPid);
    }
    return n;
  };
  return [...held].sort((a, b) => depth(b) - depth(a));
}

/**
 * This process and whichever of its ancestors are themselves in the set. An ancestor outside the
 * set is not a candidate for signalling, so the walk stops the moment it leaves.
 */
function ours(found: SlotProcess[], pid: number): boolean {
  const byPid = new Map(found.map((p) => [p.pid, p]));
  const seen = new Set<number>();
  let cur: number | undefined = process.pid;
  while (cur !== undefined && !seen.has(cur)) {
    if (cur === pid) return true;
    seen.add(cur);
    const next = byPid.get(cur);
    cur = next !== undefined ? next.parentPid : cur === process.pid ? process.ppid : undefined;
  }
  return false;
}

const run = promisify(execFile);

const TABLE_TIMEOUT_MS = 20_000;
const WALK_BUDGET_MS = 15_000;
const TABLE_BUFFER = 8 * 1024 * 1024;

/**
 * A walk of the process table, and whether it got all the way through. An incomplete walk carries
 * every holder it did find: the arms that answer the common case run to the end whatever the budget
 * does, so hits from those are a complete reading of them.
 */
interface Walk {
  held: SlotProcess[];
  complete: boolean;
}

/**
 * What an operator is told when the walk ran out of budget. It is not the probe failing — the cheap
 * arms answered in full — so the sentence says which arm was cut short and what follows from it.
 *
 * @public the pool's warning and its test read the sentence back
 */
export function partialWalk(root: string, found: number): string {
  return (
    `The walk for processes holding ${root} ran past ${WALK_BUDGET_MS}ms and stopped before it had asked every ` +
    `process for its loaded modules. ${
      found === 0
        ? 'Nothing was found by the arms that did run, so what is holding it is unknown rather than nothing.'
        : `The ${found} found by the arms that did run are swept; a holder only the module walk could have named is not.`
    }`
  );
}

/**
 * Why the probe could not answer, rather than the command it could not answer with. `execFile`'s
 * own message is the whole script and no reason at all, and the two readings that matter are not in
 * it: a walk killed at `TABLE_TIMEOUT_MS`, which reports as an ordinary failure with an empty
 * stderr, and a shell that exited non-zero, whose stderr is the only thing that says what for.
 *
 * @public the pool's warning and its test read the sentence back
 */
export function probeFailure(err: unknown): string {
  const e = err as { killed?: boolean; signal?: string; code?: unknown; stderr?: unknown; message?: string };
  const stderr = typeof e.stderr === 'string' ? firstLine(e.stderr) : '';
  const said = stderr === '' ? '' : `: ${stderr}`;
  if (e.killed === true || e.signal != null)
    return `it was still running after ${TABLE_TIMEOUT_MS}ms and was killed${said}`;
  if (typeof e.code === 'number') return `it exited ${e.code}${said}`;
  if (typeof e.code === 'string') return `${e.code}${said}`;
  return firstLine(e.message ?? String(err));
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

/**
 * Windows: what refuses an unlink is a *mapped image*, so the question asked is which processes
 * have a module loaded out of the slot — `Get-Process`'s module list, filtered in the shell so only
 * the hits cross the pipe. The executable path and the command line are asked first because they
 * are on the cheap CIM table and answer the common case without enumerating anything. `Get-Process`
 * is walked once into a table keyed by pid: asked per pid it re-walks the whole process list each
 * time, which on a busy machine is what takes the probe past its timeout.
 *
 * The two arms run as two passes, not one, and the module pass carries its own `WALK_BUDGET_MS`
 * deadline: the cheap pass therefore answers for *every* process however busy the machine is, and a
 * module pass that runs out of budget reports what it has rather than being killed at
 * `TABLE_TIMEOUT_MS` with the cheap answers still in it.
 */
async function mapped(root: string): Promise<Walk> {
  const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', HOLDERS_PS1], {
    env: { ...process.env, LUBBDUBB_SLOT: root, LUBBDUBB_SLOT_BUDGET_MS: String(WALK_BUDGET_MS) },
    windowsHide: true,
    timeout: TABLE_TIMEOUT_MS,
    maxBuffer: TABLE_BUFFER,
  });
  return parseWalk(stdout);
}

const HOLDERS_PS1 = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$root = $env:LUBBDUBB_SLOT',
  '$budget = [int]$env:LUBBDUBB_SLOT_BUDGET_MS',
  '$cmp = [System.StringComparison]::OrdinalIgnoreCase',
  '$clock = [System.Diagnostics.Stopwatch]::StartNew()',
  '$hits = New-Object System.Collections.ArrayList',
  '$rest = New-Object System.Collections.ArrayList',
  '$live = @{}',
  'foreach ($g in Get-Process) { $live[[int]$g.Id] = $g }',
  'foreach ($p in Get-CimInstance Win32_Process) {',
  '  if ($p.ProcessId -le 4) { continue }',
  '  $why = $null',
  '  if ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root, $cmp)) { $why = $p.ExecutablePath }',
  '  elseif ($p.CommandLine -and $p.CommandLine.IndexOf($root, $cmp) -ge 0) { $why = $p.CommandLine }',
  '  if ($why) {',
  '    [void]$hits.Add([pscustomobject]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; detail = $why })',
  '  } elseif ($live[[int]$p.ProcessId]) {',
  '    [void]$rest.Add($p)',
  '  }',
  '}',
  '$complete = $true',
  'foreach ($p in $rest) {',
  '  if ($clock.ElapsedMilliseconds -ge $budget) { $complete = $false; break }',
  '  try {',
  '    $g = $live[[int]$p.ProcessId]',
  '    $m = $g.Modules | Where-Object { $_.FileName -and $_.FileName.StartsWith($root, $cmp) } | Select-Object -First 1',
  '    if ($m) {',
  '      [void]$hits.Add([pscustomobject]@{ pid = $p.ProcessId; ppid = $p.ParentProcessId; detail = $m.FileName })',
  '    }',
  '  } catch { }',
  '}',
  'ConvertTo-Json -Compress -Depth 3 -InputObject ([pscustomobject]@{ complete = $complete; held = @($hits) })',
].join('\n');

/**
 * POSIX: the process table plus, where /proc exists, each process's own cwd and executable link.
 * Nothing here holds an unlink — POSIX unlinks a running image and a live process's cwd quite
 * happily — so this exists for the other half of the release: a watcher left running would go on
 * writing into the tree the next occupant is about to be handed.
 */
async function occupying(root: string): Promise<Walk> {
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,args='], {
    timeout: TABLE_TIMEOUT_MS,
    maxBuffer: TABLE_BUFFER,
  });
  const held: SlotProcess[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null || m[1] === undefined || m[2] === undefined) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const parentPid = Number(m[2]);
    const link = linkUnder(root, pid);
    if (link !== null) held.push({ pid, parentPid, detail: link });
    else if ((m[3] ?? '').includes(root)) held.push({ pid, parentPid, detail: (m[3] ?? '').trim() });
  }
  return { held, complete: true };
}

function linkUnder(root: string, pid: number): string | null {
  for (const name of ['cwd', 'exe']) {
    try {
      const target = readlinkSync(`/proc/${pid}/${name}`);
      if (target === root || isUnder(root, target)) return `${name} -> ${target}`;
    } catch {
      // A process that has since ended, or one this uid cannot look into. Neither is answerable.
    }
  }
  return null;
}

function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The walk's own report. Empty output, or a document without a `complete` of its own, is read as
 * incomplete: the script always prints its report, so nothing to read is a walk that did not finish,
 * and the one reading that must never be invented is `the walk got all the way through`.
 *
 * @public the Windows probe and its test read the document back
 */
export function parseWalk(stdout: string): Walk {
  const text = stdout.trim();
  if (text === '') return { held: [], complete: false };
  const parsed: unknown = JSON.parse(text);
  const doc = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
    complete?: unknown;
    held?: unknown;
  };
  const rows: unknown[] = Array.isArray(doc.held) ? doc.held : doc.held == null ? [] : [doc.held];
  const held: SlotProcess[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { pid, ppid, detail } = row as { pid?: unknown; ppid?: unknown; detail?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    held.push({
      pid,
      parentPid: typeof ppid === 'number' && Number.isInteger(ppid) ? ppid : 0,
      detail: typeof detail === 'string' ? detail : '',
    });
  }
  return { held, complete: doc.complete === true };
}

/**
 * What an operator is told when a slot could not be emptied. It names the wipe git refused and the
 * processes still standing in the directory, because the errno names neither and the next move —
 * go and stop that process — is in neither reading.
 *
 * @public the pool records this to the error log, and its test reads the sentence back
 */
export function slotUnusable(dir: string, detail: string, remaining: SlotProcess[] | null): string {
  const named = (remaining ?? []).slice(0, HOLDERS_NAMED).map((p) => `pid ${p.pid} (${p.detail})`);
  const rest = (remaining ?? []).length - named.length;
  const who =
    remaining === null
      ? 'The harness could not read the process table at all, so what is holding it is unknown rather than ' +
        'nothing — the warning beside this says why the probe failed.'
      : remaining.length === 0
        ? 'Nothing the harness can see is holding it now, so what refused the wipe is the directory itself rather ' +
          'than a live process — a permission, a handle from off this machine, or a scanner that had it open.'
        : `Still holding it after the sweep: ${named.join('; ')}${rest > 0 ? `, and ${rest} more` : ''}.`;
  return (
    `Worktree slot ${dir} cannot be emptied and has been taken out of the pool: ${detail} Every process the ` +
    `harness could find holding something inside the slot was terminated first, and the wipe still failed. ` +
    `${who} The slot is not offered to another branch and the dispatch went to a different one, so nothing is ` +
    `queued behind it — the pool is simply one slot smaller until the hold is released. Stop what is named ` +
    `above, or delete ${dir} by hand, and the slot is taken back into the pool the next time the pool has ` +
    `nothing else to give.`
  );
}

const HOLDERS_NAMED = 5;
