import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which build of the harness hatched a pet.
 *
 * `sha` is the install directory's HEAD; `clean` says its working tree carried no
 * uncommitted changes at the time. Both null/false when no reading could be taken
 * — a tarball install and an air-gapped machine are legitimate deployments, and
 * each should read as "no answer" rather than as a fault.
 */
export interface PetBuildStamp {
  sha: string | null;
  clean: boolean;
}

/**
 * The build the running process is, read once and remembered.
 *
 * **Why this exists at all**: taking the rates out of `lubbdubb.config.json` stops
 * an operator dialling a vivarium into existence, and stops nothing at all for one
 * willing to edit `src/pets/rules.ts` and restart. A pet that records the build
 * that rolled it makes that visible — and it is what lets the replay check in
 * `attest.ts` accuse anything safely, because a pet stamped with a build that is
 * not this one is a pet this build's constants cannot judge.
 *
 * **Why `execFileSync`, where the rest of the harness uses `runGit`.** The scan is
 * synchronous, and this answer is a constant for the life of the process: the
 * install's HEAD cannot move under a running build, and a working tree edited
 * mid-run does not reach the loaded module graph until a restart anyway. So it is
 * one pair of subprocesses per process, memoised below, rather than a promise
 * threaded through a call chain that has no other reason to be async.
 *
 * The repo asked about is **never `config.repoRoot`** — that is the codebase the
 * fleet is pointed at, and the two coincide only when LubbDubb is dogfooding
 * itself. It is resolved from this module's own path, exactly as
 * `src/selfUpdate/buildStanding.ts` does it and for the same reason.
 */
export function buildStamp(): PetBuildStamp {
  cached ??= read();
  return cached;
}

let cached: PetBuildStamp | null = null;

function read(): PetBuildStamp {
  const root = installRoot();
  if (root === null) return { sha: null, clean: false };
  try {
    const sha = git(root, ['rev-parse', 'HEAD']);
    // Every tracked change, staged or not. Untracked files are included: a
    // `rules.ts` copied over the top of the checkout is exactly the edit this is
    // watching for, and it shows up as untracked in some working styles.
    const clean = git(root, ['status', '--porcelain']).length === 0;
    return { sha, clean };
  } catch {
    // A checkout with no commits, no git binary, or no permission to run one. All
    // of them are "no reading", and none of them is worth an error log on a
    // decorative feature.
    return { sha: null, clean: false };
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * The git root the harness itself runs out of, or null when it is not running out
 * of one.
 *
 * Walks up from this module's own file rather than trusting a fixed number of
 * `..` segments: the same source runs from `src/` under `tsx` and from an `outDir`
 * after a build, and those sit at different depths. `.git` is tested as a *path*
 * rather than a directory because a checkout that is itself a git worktree has a
 * `.git` file — which is how this repo's own agents run.
 */
function installRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) return null;
    dir = up;
  }
  return null;
}
