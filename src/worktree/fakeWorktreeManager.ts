import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { slotDirName, type Worktrees } from './worktreeManager.js';

/** One recorded call, so a test can assert on the branch and base a dispatch asked for. */
interface FakeWorktreeCall {
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
 * **It models the pool, not one directory per branch.** That is the whole reason it
 * is kept in step: a fake still keyed on the branch would hand every branch its own
 * path and keep every test green while the real manager leased slots. So:
 *
 * - `ensure` leases a **free slot**, minting one only when none is free and the pool
 *   is below its bound; past the bound it rejects, as the real one does.
 * - A branch already holding a lease gets **the same directory** whatever `base`
 *   says. That property is load-bearing in production (`Store.findActiveTaskByBranch`
 *   exists because of it), and so is its consequence: a slot leased to one branch is
 *   never handed to another.
 * - A released slot keeps its occupant, so asking again for the branch that last had
 *   it gets the same directory back — the real manager's reuse-first arm.
 * - `remove` releases the lease and **deletes nothing**; the directory is the warm
 *   state the pool exists to keep.
 *
 * `base` is recorded, never honoured — there is no commit graph here to honour it
 * against.
 */
export class FakeWorktreeManager implements Worktrees {
  /** Every `ensure`, in order. */
  readonly ensured: FakeWorktreeCall[] = [];
  /** Every branch `remove` was called for, in order — including ones holding no lease. */
  readonly removed: string[] = [];
  /** Every branch `deleteBranch` was called for, in order — the local half of a reap. */
  readonly deleted: string[] = [];

  private readonly root: string;
  private readonly size: number;
  /** Slot directory per leased branch. */
  private readonly leases = new Map<string, string>();
  /** What each slot is "checked out" on, lease or no lease. */
  private readonly occupants = new Map<string, string>();
  private readonly slots: string[] = [];

  constructor(root?: string, size = DEFAULT_POOL_SIZE) {
    this.root = root ?? mkdtempSync(join(tmpdir(), 'lubbdubb-fakewt-'));
    this.size = size;
  }

  ensure(branch: string, base?: string): Promise<string> {
    this.ensured.push(base === undefined ? { branch } : { branch, base });
    const warm = this.leases.get(branch) ?? this.slots.find((dir) => this.occupants.get(dir) === branch);
    if (warm !== undefined) return Promise.resolve(this.lease(branch, warm));
    const free = this.slots.find((dir) => !this.isLeased(dir));
    if (free !== undefined) return Promise.resolve(this.lease(branch, free));
    if (this.slots.length >= this.size)
      return Promise.reject(
        new Error(`No free worktree slot for branch ${branch}: all ${this.size} slots under ${this.root} are leased.`),
      );
    const dir = resolve(this.root, slotDirName(this.slots.length));
    mkdirSync(dir, { recursive: true });
    this.slots.push(dir);
    return Promise.resolve(this.lease(branch, dir));
  }

  deleteBranch(branch: string): Promise<void> {
    this.deleted.push(branch);
    // The real one detaches the slot so the ref can go; the directory stays either way.
    const dir = this.leases.get(branch) ?? this.slots.find((d) => this.occupants.get(d) === branch);
    if (dir !== undefined) this.occupants.delete(dir);
    return this.remove(branch);
  }

  remove(branch: string): Promise<void> {
    this.removed.push(branch);
    this.leases.delete(branch);
    return Promise.resolve();
  }

  private lease(branch: string, dir: string): string {
    this.leases.set(branch, dir);
    this.occupants.set(dir, branch);
    return dir;
  }

  private isLeased(dir: string): boolean {
    for (const held of this.leases.values()) if (held === dir) return true;
    return false;
  }
}

/**
 * The fake's pool bound. Deliberately far above what any test dispatches at once,
 * because exhaustion is a thing to assert on purpose rather than to trip over: a
 * test about the bound passes its own size.
 */
const DEFAULT_POOL_SIZE = 32;
