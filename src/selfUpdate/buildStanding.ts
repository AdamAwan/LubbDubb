import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from '../git/gitCli.js';

/**
 * Where the *running build* sits relative to its own upstream — the harness
 * reading its own checkout, not the repo it works on.
 *
 * **The repo this asks about is never `config.repoRoot`.** That is the codebase the
 * fleet is pointed at, and the two coincide only when LubbDubb is dogfooding
 * itself; `loadDeploymentConfig` explicitly supports running the app from its own
 * directory against another repo. So the root here is resolved from *this module's
 * own path* ({@link installRoot}) and from nothing an operator can configure —
 * a deployment working on `markdown-magpie` still wants to hear that LubbDubb moved.
 *
 * **This fetches, and {@link GitObserver} deliberately does not.** That seam is
 * documented fetch-free so its callers own how often the remote is touched; this
 * is a different question against a different repo, so it is a separate reader
 * rather than a method there — and it owns its own network policy, which is the
 * cheap/expensive split in {@link readBuildStanding}: `ls-remote` every time, and a
 * real object transfer only once the tip has actually moved.
 */

/** One commit on upstream that the running build does not have. */
interface UpstreamCommit {
  sha: string;
  subject: string;
}

/** The reading. Every field is "as of `checkedAt`" — nothing here is live. */
export interface BuildStanding {
  /** The install directory's HEAD, or null when no reading could be taken. */
  head: string | null;
  /** Upstream's tip as the remote reported it, or null when it could not be reached. */
  upstream: string | null;
  /** Commits upstream carries that HEAD does not. Zero means current. */
  behind: number;
  /**
   * Commits HEAD carries that upstream does not — a fork, a local commit, or simply
   * a branch. Non-zero is what makes the upgrade a merge rather than a fast-forward,
   * which is why it is read rather than inferred from `behind === 0`.
   */
  ahead: number;
  /** What is waiting, newest first, capped at {@link MAX_COMMITS}. */
  commits: UpstreamCommit[];
  /**
   * Uncommitted changes to *tracked* files in the install directory. A pull over
   * these is not safe — and untracked ones are deliberately not counted, because
   * a pull over those is. See {@link readBuildStanding}.
   */
  dirty: boolean;
  /** The branch the install directory is on, or null when detached. */
  branch: string | null;
  checkedAt: string;
  /**
   * Why no reading could be taken, in the operator's words, or null when one was.
   * Carried rather than thrown: a tarball install, an air-gapped machine and a
   * checkout with no `origin` are all legitimate deployments, and each of them
   * should read as "no answer" on the gauge rather than as a fault in the log.
   */
  unavailable: string | null;
}

/** How much of the waiting history is worth showing before it stops being read. */
const MAX_COMMITS = 10;

/**
 * The git root the *harness itself* is running out of, or null when it is not
 * running out of one at all.
 *
 * One answer, three readers, and that is why it is exported rather than kept to
 * the reader below it: the Setup reading asks whether the project an operator is
 * about to point the fleet at is this checkout, and the desktop skill tells the
 * operator's own Claude where LubbDubb's source is when the question turns out to
 * be about the harness rather than about the work
 * (`src/validation/desktopSkill.ts`). A second implementation of the walk would be
 * a second answer. The two repositories coincide only when LubbDubb is dogfooding, and
 * the one time they are the same directory is the one time the cockpit has to say
 * which it means. → `docs/spec/26-setup.md#two-repositories`
 *
 * Walks up from this module's own file looking for a `.git`, rather than trusting
 * a fixed number of `..` segments: the same source runs from `src/` under `tsx`
 * and from an `outDir` after a build, and those sit at different depths. `.git`
 * is tested as a *path* rather than a directory because a checkout that is itself
 * a git worktree has a `.git` file — which is exactly how this repo's own agents
 * run, so getting it wrong would make the feature invisible in development.
 */
export function installRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Bounded rather than `while (true)`: a symlink loop or a root that never
  // matches must end the walk, not the process.
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** A reading that could not be taken, with the reason the panel will show. */
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

/**
 * Take one reading of the running build against its upstream.
 *
 * **The network cost is two shapes, and which one runs matters.** `ls-remote` is
 * one round trip that transfers no objects, and it answers the only question
 * asked most of the time: has the tip moved at all. Only when it has — and only
 * when the new tip is an object this clone does not already hold — is a real
 * `fetch` run. So the steady state of an up-to-date deployment checking hourly is
 * a single ref advertisement, and the expensive path costs what it costs exactly
 * once per upstream commit.
 *
 * Nothing here touches the working tree, and no caller of this ever runs `pull`:
 * applying an update is the supervisor's job, between two dead processes.
 */
export async function readBuildStanding(opts: {
  remote: string;
  branch: string;
  now: () => string;
  /** The install directory, for the test that stands in a checkout it controls. */
  root?: string;
}): Promise<BuildStanding> {
  const at = opts.now();
  const root = opts.root ?? installRoot();
  if (!root) return noReading('LubbDubb is not running from a git checkout, so it cannot see its own updates', at);

  let head: string;
  let branch: string | null;
  let dirty: boolean;
  try {
    head = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
    // `--quiet` exits 1 on a detached HEAD rather than printing garbage, and a
    // detached build is a legitimate thing to be running — it just has no branch.
    branch = await gitOrNull(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    // `--untracked-files=no`, and the flag is the whole point of the line. The
    // supervisor applies an update with `pull --ff-only`, which an untracked file
    // does not stand in the way of — but a bare `--porcelain` lists them, so one
    // stray file in the install directory (an operator's note, a dropped log, a
    // path a newer build writes that this checkout's older `.gitignore` never
    // learned) reads as "uncommitted changes" and takes the upgrade button away
    // for good. That is worst on exactly the deployment that most needs it: the
    // longer a build goes untouched, the more it has picked up. It also kept the
    // *reading* itself off a checkout with enough untracked files to overrun the
    // pipe, which came back as "could not read the install directory".
    dirty = (await runGit(root, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim().length > 0;
  } catch (err) {
    return noReading(`could not read the install directory: ${(err as Error).message}`, at);
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

  // The tip moved, but this clone may already hold the object — an operator who
  // fetched by hand, or a second check before the supervisor ran. Asking first is
  // what keeps a repeat check off the wire.
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
    // A unit separator, because a commit subject may contain anything a person
    // can type — including whatever single character seemed safe.
    '--format=%h%x1f%s',
    `${head}..${upstream}`,
  ]);
  const commits = (log ?? '')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, ...rest] = line.split('\x1f');
      return { sha: sha ?? '', subject: rest.join('\x1f') };
    });

  return { ...current, ahead: ahead!, behind: behind!, commits };
}

/**
 * Run git for an answer that may legitimately not exist. A non-zero exit here is
 * one of the answers — a detached HEAD, an unreachable remote, an object this
 * clone does not hold — so it comes back as null rather than as a throw the
 * caller would have to re-classify.
 */
async function gitOrNull(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runGit(root, args);
    return stdout.trim();
  } catch {
    return null;
  }
}
