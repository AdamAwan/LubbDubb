import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../git/gitCli.js';

// → docs/spec/21-self-update.md

interface UpstreamCommit {
  sha: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface BuildStanding {
  head: string | null;
  upstream: string | null;
  behind: number;
  ahead: number;
  commits: UpstreamCommit[];
  dirty: boolean;
  branch: string | null;
  checkedAt: string;
  unavailable: string | null;
}

const MAX_COMMITS = 10;

export function installRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function noReading(reason: string, at: string): BuildStanding {
  return {
    head: null,
    upstream: null,
    behind: 0,
    ahead: 0,
    commits: [],
    dirty: false,
    branch: null,
    checkedAt: at,
    unavailable: reason,
  };
}

export async function readBuildStanding(opts: {
  remote: string;
  branch: string;
  now: () => string;
  root?: string;
  subject?: string;
}): Promise<BuildStanding> {
  const at = opts.now();
  const root = opts.root ?? installRoot();
  if (!root) return noReading('LubbDubb is not running from a git checkout, so it cannot see its own updates', at);

  let head: string;
  let branch: string | null;
  let dirty: boolean;
  try {
    head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
    // TECHDEBT: `--quiet` exits 1 on a detached HEAD rather than printing garbage, and a
    // detached build is a legitimate thing to be running — it just has no branch.
    branch = await gitOrNull(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    dirty = (await runGit(root, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim().length > 0;
  } catch (err) {
    return noReading(`could not read ${opts.subject ?? 'the install directory'}: ${(err as Error).message}`, at);
  }

  const upstream = await gitOrNull(root, ['ls-remote', '--exit-code', opts.remote, `refs/heads/${opts.branch}`]).then(
    (out) => out?.split(/\s+/)[0] ?? null,
  );
  if (!upstream)
    return {
      ...noReading(`could not reach ${opts.remote}/${opts.branch} to check for updates`, at),
      head,
      branch,
      dirty,
    };

  const current = { head, upstream, behind: 0, ahead: 0, commits: [], dirty, branch, checkedAt: at, unavailable: null };
  if (upstream === head) return current;

  const held = await gitOrNull(root, ['cat-file', '-e', `${upstream}^{commit}`]);
  if (held === null) {
    try {
      await runGit(root, ['fetch', '--quiet', opts.remote, opts.branch]);
    } catch (err) {
      return { ...current, unavailable: `could not fetch ${opts.remote}/${opts.branch}: ${(err as Error).message}` };
    }
  }

  const counts = await gitOrNull(root, ['rev-list', '--left-right', '--count', `${head}...${upstream}`]);
  const [ahead, behind] = (counts ?? '').trim().split(/\s+/).map(Number);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind))
    return { ...current, unavailable: 'could not count the commits between this build and upstream' };

  const log = await gitOrNull(root, [
    'log',
    `--max-count=${MAX_COMMITS}`,
    '--format=%h%x1f%aN%x1f%aI%x1f%s',
    `${head}..${upstream}`,
  ]);
  const commits = (log ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, author, authoredAt, ...rest] = line.split('\x1f');
      return { sha: sha ?? '', author: author ?? '', authoredAt: authoredAt ?? '', subject: rest.join('\x1f') };
    });

  return { ...current, ahead: ahead!, behind: behind!, commits };
}

export async function pullFastForward(opts: {
  root: string;
  remote: string;
  branch: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runGit(opts.root, ['pull', '--ff-only', opts.remote, opts.branch]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `the pull failed: ${(err as Error).message}` };
  }
}

async function gitOrNull(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, args);
    return stdout.trim();
  } catch {
    return null;
  }
}
