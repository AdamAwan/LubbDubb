import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Worktrees } from './worktreeManager.js';

/** One recorded call, so a test can assert on the branch and base a dispatch asked for. */
export interface FakeWorktreeCall {
  branch: string;
  base?: string;
}

/**
 * A {@link Worktrees} that touches no repository — the write-side counterpart to
 * {@link FakeGitObserver}. Injected via `buildSystem`'s `worktrees` option by every
 * test whose subject is the harness rather than git.
 *
 * It hands back a **real, empty directory** rather than a synthetic path. An
 * agent's worktree is its cwd, and things downstream genuinely touch it — the
 * file-events spool, and `resolveConfinedArtifact`, which `realpathSync`es the
 * root before serving anything — so a path that doesn't exist would fail those
 * tests for reasons that have nothing to do with git.
 *
 * **Reuse-first, like the real one**: the same branch resolves to the same
 * directory whatever `base` says. That property is load-bearing in production
 * (`Store.findActiveTaskByBranch` exists because of it), so a fake that minted a
 * fresh path per call would let a test assert behaviour the real manager doesn't
 * have. `base` is recorded, never honoured — there is no commit graph here to
 * honour it against.
 */
export class FakeWorktreeManager implements Worktrees {
  /** Every `ensure`, in order. */
  readonly ensured: FakeWorktreeCall[] = [];
  /** Every branch `remove` was called for, in order — including ones with no worktree. */
  readonly removed: string[] = [];

  private readonly root: string;
  private readonly dirs = new Map<string, string>();

  constructor(root?: string) {
    this.root = root ?? mkdtempSync(join(tmpdir(), 'lubbdubb-fakewt-'));
  }

  ensure(branch: string, base?: string): Promise<string> {
    this.ensured.push(base === undefined ? { branch } : { branch, base });
    const existing = this.dirs.get(branch);
    if (existing) return Promise.resolve(existing);
    const dir = resolve(this.root, sanitize(branch));
    mkdirSync(dir, { recursive: true });
    this.dirs.set(branch, dir);
    return Promise.resolve(dir);
  }

  remove(branch: string): Promise<void> {
    this.removed.push(branch);
    const dir = this.dirs.get(branch);
    if (!dir) return Promise.resolve();
    this.dirs.delete(branch);
    rmSync(dir, { recursive: true, force: true });
    return Promise.resolve();
  }

  /** The directory `ensure` handed out for a branch, or null — the fake's `findExisting`. */
  pathFor(branch: string): string | null {
    return this.dirs.get(branch) ?? null;
  }
}

/** The real manager's own path rule, so a fake path is wrong in the same ways. */
function sanitize(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9._-]/g, '-');
}
