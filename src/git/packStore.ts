import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// → docs/spec/09-execution.md#the-clones-object-store

export interface PackStore {
  packs: number;
  bytes: number;
  promisorPacks: number;
}

export interface OrphanSweep {
  keeps: string[];
  tmpFiles: string[];
}

/** Older than this, a `tmp_pack_*` nothing is writing to belongs to a git that is no longer running. */
const TMP_PACK_STALE_MS = 60 * 60_000;

// A file's mtime comes off a coarser clock than `Date.now()`, so one written just after it reads as before.
const MTIME_SLACK_MS = 2_000;
const KEEP_OWNER = /^\S+ (\d+) on (\S+)/;
const TMP_FILE = /^tmp_(pack|idx|rev)_/;

/** The object store every worktree of the clone at `cwd` shares, found without running git. */
export function commonGitDir(cwd: string): string | null {
  let at = resolve(cwd);
  for (;;) {
    const dotGit = join(at, '.git');
    if (existsSync(dotGit)) return fromDotGit(dotGit);
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

function fromDotGit(dotGit: string): string | null {
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
    if (pointer === null) return null;
    const gitDir = resolve(dirname(dotGit), pointer[1]!.trim());
    const commondir = join(gitDir, 'commondir');
    if (!existsSync(commondir)) return gitDir;
    const common = readFileSync(commondir, 'utf8').trim();
    return isAbsolute(common) ? resolve(common) : resolve(gitDir, common);
  } catch {
    return null;
  }
}

function packDir(gitDir: string): string {
  return join(gitDir, 'objects', 'pack');
}

export function readPackStore(gitDir: string): PackStore {
  const out: PackStore = { packs: 0, bytes: 0, promisorPacks: 0 };
  const dir = packDir(gitDir);
  for (const name of listing(dir)) {
    if (name.endsWith('.pack')) {
      out.packs += 1;
      out.bytes += sizeOf(join(dir, name));
    } else if (name.endsWith('.promisor')) out.promisorPacks += 1;
    else if (TMP_FILE.test(name)) out.bytes += sizeOf(join(dir, name));
  }
  return out;
}

/**
 * Removes what a git killed mid-fetch leaves in the pack directory: a `.keep` naming a process on
 * this host that is no longer alive, and a `tmp_pack_*` nothing has written to for an hour — or,
 * after a reap, one written since it started and not growing over `settleMs`. Never throws.
 */
export async function clearOrphans(gitDir: string, reaped?: { since: number; settleMs: number }): Promise<OrphanSweep> {
  const dir = packDir(gitDir);
  const names = listing(dir);
  const keeps = names
    .filter((n) => n.endsWith('.keep'))
    .map((n) => join(dir, n))
    .filter((path) => keepIsOrphaned(path) && remove(path));
  const tmp = names.filter((n) => TMP_FILE.test(n)).map((n) => join(dir, n));
  const before = new Map(tmp.map((path) => [path, mtimeOf(path)]));
  if (reaped !== undefined) await new Promise((settled) => setTimeout(settled, reaped.settleMs).unref());
  const abandoned = (path: string): boolean => {
    const was = before.get(path) ?? null;
    const is = mtimeOf(path);
    if (was === null || is === null) return false;
    if (Date.now() - is >= TMP_PACK_STALE_MS) return true;
    return reaped !== undefined && is >= reaped.since - MTIME_SLACK_MS && is === was;
  };
  return { keeps, tmpFiles: tmp.filter((path) => abandoned(path) && remove(path)) };
}

function keepIsOrphaned(path: string): boolean {
  let said: string;
  try {
    said = readFileSync(path, 'utf8');
  } catch {
    return false;
  }
  const owner = KEEP_OWNER.exec(said.trim());
  if (owner === null) return false;
  if (owner[2]!.toLowerCase() !== hostname().toLowerCase()) return false;
  return !alive(Number(owner[1]));
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function listing(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function remove(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return !existsSync(path);
  } catch {
    return false;
  }
}
