import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { runGit, resolveCommit } from '../git/gitCli.js';

/**
 * Git's *write* side, as the one seam the executor depends on. Its read side has
 * had {@link GitObserver} and a fake since plan reconciliation needed one; this
 * half — the half that mutates the repo — had neither, so every test that
 * dispatched a code agent cut a real branch in whatever checkout `repoRoot`
 * happened to name (`process.cwd()` by default) and never deleted it.
 *
 * Deliberately four methods: `ensure`/`ensureReadOnly`/`remove`/`deleteBranch` is the
 * whole of what {@link ActionExecutor} and the reap in `system.ts` ask for, and a
 * seam wider than its consumer is a fake with behaviour nobody checks.
 */
export interface Worktrees {
  /**
   * Path to a worktree for `branch`, leasing a pool slot for it. A slot already on
   * the branch is handed back with everything in it; any other slot is wiped to
   * what a fresh checkout would hold before it is switched over. Throws when no
   * slot is free — the dispatch is rejected rather than queued behind a directory.
   */
  ensure(branch: string, base?: string): Promise<string>;
  /**
   * Path to a **read-only** checkout of `of`, leased under `key` (issue #396).
   *
   * For the dispatches that need a repository and no branch — the assay, the
   * assessment, a validation check — each of which is told in its prompt not to
   * commit or push anything, and each of which used to mint a branch cut from the
   * default one. That branch never got a pull request, so it was never merged, so
   * `reapableBranches` never deleted it: one ref per assay, per assessment and per
   * check, accumulating for the life of the deployment.
   *
   * So nothing is minted at all. The slot is checked out **detached** at the commit
   * `of` resolves to, and there is no ref to leave behind on either side. `key` is a
   * lease key rather than a branch: it is what {@link remove} releases, what the
   * task row carries, and what the branch gate reads — everything the pool needs a
   * name for, without a name in `refs/heads`.
   */
  ensureReadOnly(key: string, of: string): Promise<string>;
  /**
   * Release the lease `ensure` or {@link ensureReadOnly} took. **The directory
   * stays**, still on the branch (or at the commit) and with everything git ignores
   * in it, so the same work coming back starts warm.
   */
  remove(branch: string): Promise<void>;
  /**
   * Release the lease *and* the local branch ref — the local half of the reap after
   * a pull request merges. A branch that does not exist locally is a no-op.
   */
  deleteBranch(branch: string): Promise<void>;
}

/**
 * A bounded pool of git worktree directories, leased to branches on demand.
 *
 * **Why a pool and not a directory per branch.** Every goal mints branches — the
 * assay, the pickup, one per plan part — and the old manager created a directory
 * per branch and deleted it when the work ended. So a branch that came back — a CI
 * failure to chase, a review comment to answer, a part picked up again — landed in
 * a tree with nothing installed and paid to install it before it could run one
 * check: minutes of wall clock and several tool turns per dispatch, for setup whose
 * answer had been sitting on disk an hour earlier. A slot left standing on its
 * branch keeps everything git ignores, which is where a project's build state
 * lives — so warm dependencies are a *consequence* of a branch finding its own tree
 * again, not something the harness manages. Nothing here knows what a package
 * manager is, and nothing here should learn.
 *
 * **Reuse is scoped to the branch, and nothing crosses.** A slot handed to a
 * *different* branch is wiped back to what a fresh checkout would hold (see
 * {@link handOver}). The previous occupant's ignored output is an answer to its own
 * branch's source, and an agent that reads a `dist/` its branch never built is
 * wrong in a way nothing marks as stale and no test catches. The cost is the cold
 * install on a branch's first dispatch, and that is the trade: a tree is only warm
 * for the work that warmed it.
 *
 * **What a directory per branch was silently providing.** It was the only thing
 * stopping two agents sharing a checkout: one branch, one path, so a second agent
 * on a different branch could not land in the first one's tree. Pooling breaks that
 * coupling, so the lease below is explicit and checked on every hand-out. Getting it
 * wrong would put two agents in one directory on different branches — worse than
 * anything `fileOverlap` reports, since `sameWorktree` at least assumes they agree
 * on the branch.
 *
 * **A read-only checkout is a slot like any other** (issue #396). It is detached at
 * a commit instead of switched onto a branch, and it takes a lease under its key on
 * exactly the same terms — the property the lease exists for does not care whether
 * the thing holding a directory has a ref. What differs is only what a hand-over
 * costs: see {@link WorktreeManager.handOver} for why one read-only checkout of a
 * ref is warm for the next.
 *
 * Desk tasks never call any of this.
 */
export class WorktreeManager implements Worktrees {
  /**
   * The slot this run handed to each branch, until {@link remove} releases it.
   *
   * **In memory on purpose, and it is only half the lease.** It covers the window a
   * durable reading cannot: an agent's task is settled the moment it reports done,
   * but its *process* is still sitting in the directory until `reaped` fires, and
   * cleaning and switching a tree out from under an exiting process is exactly the
   * kind of damage that shows up as an `EBUSY` two days later. `system.ts` releases
   * on `reaped`, which is the honest end of "something is still in there".
   *
   * The other half is {@link WorktreeManager.pool.held}, and it is the half that
   * survives a restart — see there.
   */
  private readonly leases = new Map<string, string>();

  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
    private readonly pool: {
      /**
       * Hard bound on how many slot directories may exist under `worktreeRoot`.
       * Disk is then bounded too, which the old manager never was: twenty
       * concurrent agents meant twenty full checkouts and no ceiling at all.
       */
      size: number;
      /**
       * Whether the harness still has work in flight on a branch — wired to
       * `Store.findActiveTaskByBranch`, the same predicate the executor's branch
       * gate asks.
       *
       * **This is what makes the lease survive a restart.** A restart empties
       * {@link WorktreeManager.leases}, and crash recovery may then *restore* an
       * orphan back into its existing directory; with the in-memory half alone the
       * very next dispatch would clean and switch that tree under the restored
       * agent. A restored orphan's task is still outstanding, so this reports its
       * slot held. The mirror case is the release the boot needs: `requeue` and
       * `remove` verdicts settle the task, and the slot is free that instant.
       */
      held: (branch: string) => boolean;
    },
  ) {}

  /**
   * Return the path to a worktree for `branch`, leasing a slot for it — the
   * writable shape, and the order the slot is chosen in is {@link acquire}'s.
   *
   * **Reuse comes first, it is scoped to the branch, and `base` is then ignored
   * entirely** — a slot already checked out on the branch is handed back untouched,
   * with everything in it. That is deliberate (you don't move an in-flight agent's
   * branch out from under it), but it means `ensure(branch, base)` does *not*
   * guarantee the branch is based on `base`; it only decides where a branch that
   * didn't exist starts. Two tasks on one branch therefore share a checkout rather
   * than fighting over it, exactly as they did before there was a pool.
   */
  ensure(branch: string, base?: string): Promise<string> {
    return this.acquire({ readOnly: false, name: branch, base });
  }

  /**
   * A detached checkout of `of`, leased under `key` — the read-only shape, see
   * {@link Worktrees.ensureReadOnly}.
   *
   * `of` is required where `ensure`'s `base` is not, and for the reason `base`
   * throws rather than falling back: a read-only dispatch exists to read one
   * particular state of the repository, and the repo root's HEAD is whatever an
   * operator last left checked out.
   */
  ensureReadOnly(key: string, of: string): Promise<string> {
    return this.acquire({ readOnly: true, name: key, of });
  }

  /**
   * Lease a slot for `req` — the one path both {@link ensure} and
   * {@link ensureReadOnly} take, so the lease is checked once rather than twice.
   *
   * In order, and the order is the whole of the pool's policy:
   *
   * 1. The slot the request **already holds** — a worktree checked out on the
   *    branch, or (read-only) a slot this key still holds a lease or a mark on. It
   *    is handed back untouched, with everything in it. This is the only arm that
   *    reuses anything, and the reason two tasks on one name share a checkout
   *    rather than fighting over it.
   * 2. (Read-only only) a free slot that is already a read-only checkout of the
   *    same ref. Handing it over costs nothing and burns nothing — every read-only
   *    checkout of one ref is the same tree to whoever gets it — so it beats both
   *    a spare and a fresh slot, and it is what stops a fleet of assays and
   *    validation checks paying for a cold install each.
   * 3. A **spare** slot — free, and on a detached HEAD nothing marks or a branch
   *    whose ref is gone, so it holds nothing anybody can come back for.
   * 4. A **new** slot, while the pool is below its bound. Minting comes ahead of
   *    eviction because a slot handed to another branch is wiped either way, so
   *    taking one that still carries a live branch would burn that branch's tree
   *    for nothing — and that tree is exactly what a CI fix or a review comment on
   *    it comes back to.
   * 5. The first **evictable** slot: free, but still carrying something. It is
   *    wiped and switched (see {@link handOver}).
   *
   * With none of the five, this **throws**. So does a `base`/`of` that resolves to
   * nothing — silently picking an incidental base is the bug those parameters exist
   * to fix — and so does a switch git refuses. The executor records each as a
   * rejected dispatch, **never** a silent fall back to a fresh directory, which
   * would put two agents in one tree.
   */
  private async acquire(req: Request): Promise<string> {
    // Cheap, idempotent, and it must run before the slot scan rather than inside
    // {@link reclaim}: a slot whose directory vanished leaves an admin entry that
    // would otherwise read as an occupied path forever, so the pool would shrink
    // by one per lost directory with nothing to say so.
    await this.git(['worktree', 'prune']).catch(() => {});

    if (!req.readOnly) {
      const existing = await this.findExisting(req.name);
      if (existing) return this.lease(req.name, existing);
    }

    mkdirSync(this.worktreeRoot, { recursive: true });
    const slots = await this.slots();
    const survey = await this.survey(slots, req);
    // A read-only key's own slot, which git cannot answer for: nothing is checked
    // out under that name, so the mark and the lease are all there is to go on.
    if (survey.own !== null) return this.lease(req.name, survey.own);
    const take = survey.warm ?? survey.spare;
    if (take !== null) {
      await this.handOver(take, req);
      return this.lease(req.name, take);
    }

    const minted = this.nextSlotPath(slots);
    if (minted !== null) {
      await this.reclaim(minted);
      await this.create(minted, req);
      return this.lease(req.name, minted);
    }

    if (survey.evictable === null) throw new Error(this.exhausted(req, survey.blocked));
    await this.handOver(survey.evictable, req);
    return this.lease(req.name, survey.evictable);
  }

  /** Path of an existing worktree checked out on the branch, or null. */
  async findExisting(branch: string): Promise<string | null> {
    const entries = await this.registered();
    const match = entries.find((e) => e.branch === branch || e.branch === `refs/heads/${branch}`);
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  /**
   * Release the lease. Nothing is deleted, which is the whole change: the slot stays
   * on the branch with everything git ignores in it, so the *same* branch coming
   * back — the CI fix, the answer to a review comment — starts warm. Another branch
   * being handed the slot wipes it; the lease ending is what makes it eligible for
   * that, not what does it.
   *
   * A failed or killed agent's tree therefore survives for inspection the way it
   * always did — until the slot is reissued, which is the trade pooling makes. What
   * it must *not* do is go on holding the slot: nothing would ever release it and
   * the pool would shrink by one per failure.
   */
  remove(branch: string): Promise<void> {
    this.leases.delete(branch);
    return Promise.resolve();
  }

  /**
   * Release the lease and then delete the branch ref itself, for a branch whose pull
   * request has merged.
   *
   * **`-D`, not `-d`.** `merge_pr` squashes, and a squash-merged branch has no
   * ancestry link to the base it landed in — so `-d`'s "is this merged" test says no
   * for every branch this is ever called on, and the reap would silently never
   * delete anything. The safety `-d` offers is already provided by the caller, which
   * only asks for branches the provider says are merged.
   *
   * **The slot is detached, not removed.** `git branch -D` refuses a branch that is
   * checked out anywhere, and the directory is no longer this branch's to delete —
   * detaching frees the ref and leaves the warm tree standing for the next occupant.
   * The repo's own main worktree is left alone: detaching an operator's checkout to
   * reap a branch would be a rude surprise, and `-D` failing loudly is the honest
   * answer there.
   *
   * A branch that is not there is a no-op rather than a failure: the reap's question
   * is whether the ref is gone, and both answers satisfy it.
   */
  async deleteBranch(branch: string): Promise<void> {
    await this.remove(branch);
    const holding = await this.findExisting(branch);
    if (holding !== null && holding !== resolve(this.repoRoot)) await runGit(holding, ['switch', '--detach']);
    if (!(await this.branchExists(branch))) return;
    await this.git(['branch', '-D', branch]);
  }

  /** Record the lease and hand the path back — the one place a lease is taken. */
  private lease(branch: string, dir: string): string {
    this.leases.set(branch, dir);
    return dir;
  }

  /**
   * The free slots worth taking, in the flavours {@link acquire} chooses between —
   * and, when there are none, why each of the others was not free.
   *
   * A slot's **own** arm is the read-only half of `ensure`'s reuse: a key holding a
   * lease or a mark on a slot gets it back untouched, the way a branch checked out
   * in one does. A **warm** slot is already a read-only checkout of the ref being
   * asked for, so a hand-over neither costs nor burns anything (see
   * {@link handOver}) — read-only work is the one case where a free slot carrying
   * something is *better* than an empty one. A **spare** holds nothing anybody can
   * come back for: it sits on an unmarked detached HEAD, or on a branch whose ref is
   * gone — what {@link deleteBranch} leaves behind when a pull request merges. An
   * **evictable** slot is free but still carrying a branch or another ref's
   * read-only tree, so handing it over burns something that may yet be wanted —
   * which is why {@link acquire} grows the pool before it reaches for one.
   *
   * Two conditions make a slot neither, and the second is a correctness rule rather
   * than a convenience. **A slot carrying uncommitted tracked changes is never
   * handed to another branch**: `git switch` happily *carries* uncommitted edits
   * across when they do not conflict, so a failed agent's half-finished work would
   * land on an unrelated branch and be committed there by an agent that has no idea
   * where it came from. Refusing the slot is also what makes a switch failure
   * exceptional enough to reject a dispatch over.
   *
   * The reason each blocked slot is blocked is collected as it goes, because the
   * message an exhausted pool throws is the operator's only handle on it — "no free
   * slot" alone names neither what is holding them nor what to do.
   */
  private async survey(slots: WorktreeEntry[], req: Request): Promise<Survey> {
    const blocked: string[] = [];
    let warm: string | null = null;
    let spare: string | null = null;
    let evictable: string | null = null;
    for (const slot of slots) {
      const mark = readMark(this.markPath(slot.path));
      const holder = this.holder(slot, mark);
      if (holder !== null) {
        // Its own holder is not a blocker but the reuse arm: a second task under one
        // name shares the checkout rather than fighting over it, and after a restart
        // the mark plus `pool.held` is the only thing that still says so.
        if (holder === req.name) return { own: slot.path, warm, spare, evictable, blocked };
        blocked.push(`${slot.path} (work in flight on ${holder})`);
        continue;
      }
      if (await this.dirty(slot.path)) {
        blocked.push(`${slot.path} (uncommitted changes on ${shortBranch(slot.branch) ?? 'a detached HEAD'})`);
        continue;
      }
      if (req.readOnly && mark !== null && mark.of === req.of) {
        warm ??= slot.path;
        continue;
      }
      const occupant = shortBranch(slot.branch);
      if (mark === null && (occupant === null || !(await this.branchExists(occupant)))) {
        spare ??= slot.path;
        // A spare beats everything a writable request can reach below it, so there is
        // nothing left to survey — `blocked` is read only by the refusal, which this
        // arm has already made unreachable. A read-only request scans on, because a
        // warm slot beats a spare one for it.
        if (!req.readOnly) return { own: null, warm, spare, evictable, blocked };
        continue;
      }
      evictable ??= slot.path;
    }
    return { own: null, warm, spare, evictable, blocked };
  }

  /**
   * The name still holding this slot, or null when nothing does — the lease, asked.
   *
   * The three arms are the two halves described on {@link WorktreeManager.leases}
   * and `pool.held`, with the read-only one folded into the second. They cover
   * windows the others cannot: this run's own lease runs until the process is
   * reaped, and what a restart has left to go on is what is *in* the slot — the
   * branch checked out in it, or the key its mark names.
   *
   * **The mark is why a read-only slot survives a restart.** A detached checkout
   * has no ref for `pool.held` to be asked about, so without it a restored assayer's
   * tree would read as a spare and be cleaned and switched under the agent still
   * sitting in it — the exact damage the lease exists to refuse, and silent.
   */
  private holder(slot: WorktreeEntry, mark: Mark | null): string | null {
    const leased = this.leaseOn(slot.path);
    if (leased !== null) return leased;
    const occupant = shortBranch(slot.branch);
    if (occupant !== null && this.pool.held(occupant)) return occupant;
    if (mark !== null && this.pool.held(mark.key)) return mark.key;
    return null;
  }

  private leaseOn(dir: string): string | null {
    for (const [branch, held] of this.leases) if (held === dir) return branch;
    return null;
  }

  /** Does this slot carry changes to *tracked* files that nobody has committed? */
  private async dirty(dir: string): Promise<boolean> {
    try {
      const { stdout } = await runGit(dir, ['status', '--porcelain', '--untracked-files=no']);
      return stdout.trim() !== '';
    } catch {
      // A slot git cannot even read is not one to hand out.
      return true;
    }
  }

  /**
   * Wipe a free slot back to a fresh checkout and switch it onto what `req` asks
   * for — a branch, or a detached commit.
   *
   * **`-ffdx`, and the reach is the whole point.** This runs only for work the slot
   * is *not* already holding — {@link acquire}'s reuse arm has taken every other
   * case — so everything standing in the directory belongs to some other branch: a
   * dependency tree resolved from a different lockfile, a `dist/` built from source
   * this branch has never seen. `-x` is what takes those, and the second `-f` is for
   * a nested repository inside them (a git-sourced dependency), which a single `-f`
   * skips — leaving exactly the half-deleted dependency tree this exists to avoid
   * handing anyone. Nothing is excluded by name: an ignore list of paths to keep is
   * the repo-specific configuration the harness must not grow.
   *
   * **One hand-over keeps the ignored files, and only one**: a read-only checkout
   * of a ref, handed to another read-only checkout of the *same* ref. The wipe
   * exists because the previous occupant's output answers a different source, and
   * here it answers the same one — the default branch as the harness resolves it —
   * so `-ffd` takes the last agent's scratch and leaves the build state standing.
   * That is what stops a queue of assays and validation checks paying for a cold
   * install each, which the pool could never give work that warms nothing of its
   * own. The mark is the whole of the evidence: it is written only by a read-only
   * hand-over and cleared by every other, so a tree the harness cannot vouch for is
   * wiped.
   *
   * **Ordering.** The mark is cleared before anything is touched, so a failure
   * between here and the switch leaves a slot claiming nothing rather than claiming
   * to be a checkout it is not. The wipe runs before the switch because `git switch`
   * refuses when an untracked file would be overwritten. The start point is resolved
   * before all of it, so an unresolvable `base` leaves the slot exactly as it was
   * rather than wiped and half-prepared.
   *
   * **The reset forms are unreachable, and that is the point.** `git switch -C` and
   * `git checkout -B` *reset* an existing branch to the start point, which on a slot
   * being handed to a branch that already has commits — a re-dispatch, a retry, a
   * part picked up again — discards them with nothing red anywhere. So existence is
   * checked first and the create form is only ever reached for a branch that does
   * not exist.
   */
  private async handOver(dir: string, req: Request): Promise<void> {
    const mark = readMark(this.markPath(dir));
    const warm = req.readOnly && mark !== null && mark.of === req.of;
    const onto = await this.switchOnto(req);
    this.mark(dir, null);
    try {
      await runGit(dir, ['clean', warm ? '-ffd' : '-ffdx']);
      await runGit(dir, onto);
    } catch (err) {
      throw new Error(`Cannot hand worktree slot ${dir} to ${describe(req)}: ${(err as Error).message}`);
    }
    if (req.readOnly) this.mark(dir, { key: req.name, of: req.of });
  }

  /** Add a brand-new slot directory, already holding what `req` asks for. */
  private async create(dir: string, req: Request): Promise<void> {
    // A slot minted onto a path a dead one left behind inherits its mark otherwise,
    // and would then read as a read-only tree nobody prepared.
    this.mark(dir, null);
    if (req.readOnly) {
      await this.git(['worktree', 'add', '--detach', dir, await this.startPoint(req.name, req.of)]);
      this.mark(dir, { key: req.name, of: req.of });
      return;
    }
    if (await this.branchExists(req.name)) {
      await this.git(['worktree', 'add', dir, req.name]);
      return;
    }
    await this.git(['worktree', 'add', '-b', req.name, dir, await this.startPoint(req.name, req.base)]);
  }

  /**
   * How a prepared slot is pointed at what it is going to hold — detached at a
   * commit for a read-only checkout, switched onto a branch otherwise.
   *
   * Resolved before the slot is touched, so an unresolvable `base` or `of` leaves it
   * exactly as it was rather than wiped and half-prepared. The create form is only
   * reachable for a branch that does not exist, which is what keeps `switch -C`
   * unreachable — see {@link handOver}.
   */
  private async switchOnto(req: Request): Promise<string[]> {
    if (req.readOnly) return ['switch', '--quiet', '--detach', await this.startPoint(req.name, req.of)];
    if (await this.branchExists(req.name)) return ['switch', '--quiet', req.name];
    return ['switch', '--quiet', '-c', req.name, await this.startPoint(req.name, req.base)];
  }

  /**
   * Where a branch that does not exist yet starts, or where a read-only checkout is
   * pinned — as a **commit**.
   *
   * An omitted `base` means the repo root's HEAD — what `git worktree add -b` used
   * to fork from implicitly. It is named explicitly now because a pooled slot's own
   * HEAD is the *previous occupant's*, so leaving it implicit would silently mis-base
   * every branch cut into a reused slot.
   */
  private async startPoint(name: string, base?: string): Promise<string> {
    if (base === undefined) {
      const { stdout } = await this.git(['rev-parse', 'HEAD']);
      return stdout.trim();
    }
    const startPoint = await resolveCommit(this.repoRoot, base);
    if (!startPoint)
      throw new Error(
        `Cannot prepare a worktree for ${name}: base '${base}' resolves to no commit in ${this.repoRoot}.`,
      );
    return startPoint;
  }

  /**
   * Read, write or clear a slot's read-only mark.
   *
   * **Beside the slots rather than inside one.** A file in the worktree would be a
   * stray in front of the agent and `clean -ffdx`'s to take; a file in git's admin
   * directory would be the harness writing into git's own bookkeeping. `worktreeRoot`
   * is the pool's, so the pool's record of what a slot holds lives there — and a
   * lost mark degrades the way a lost lease does, to a full wipe.
   */
  private mark(dir: string, mark: Mark | null): void {
    const path = this.markPath(dir);
    if (mark === null) {
      rmSync(path, { force: true });
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(mark));
  }

  private markPath(dir: string): string {
    return resolve(this.worktreeRoot, MARKS_DIR, basename(dir));
  }

  /** The pool: every registered worktree under `worktreeRoot`, in a stable order. */
  private async slots(): Promise<WorktreeEntry[]> {
    const entries = await this.registered();
    return entries.filter((e) => isUnder(this.worktreeRoot, e.path)).sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  /**
   * Where the next slot would go, or null when the pool is at its bound.
   *
   * The lowest unused index rather than a count, so a pool that lost a slot fills the
   * hole instead of walking its names upward. A directory left by a pre-pool
   * deployment (named after a branch) is a registered worktree under the same root,
   * so it counts toward the bound and is reused like any other slot — the migration
   * is that there isn't one.
   */
  private nextSlotPath(slots: WorktreeEntry[]): string | null {
    if (slots.length >= this.pool.size) return null;
    const taken = new Set(slots.map((e) => e.path));
    for (let i = 0; i < this.pool.size; i += 1) {
      const dir = resolve(this.worktreeRoot, slotDirName(i));
      if (!taken.has(dir)) return dir;
    }
    return null;
  }

  /**
   * What an exhausted pool says. Rejecting is preferable to blocking — the executor
   * already records a rejected dispatch and settles the task, and the next cycle
   * tries again — but a rejection that does not name the slots or the knob is a dead
   * end for whoever reads the decision log.
   */
  private exhausted(req: Request, blocked: string[]): string {
    return (
      `No free worktree slot for ${describe(req)}: all ${this.pool.size} slots under ${this.worktreeRoot} are ` +
      `unavailable — ${blocked.join('; ')}. A slot is held while the harness has work in flight on the branch ` +
      'checked out in it, and a slot carrying uncommitted tracked changes is never handed to another branch, ' +
      'because git would carry those edits across onto it. Raise `worktreePoolSize`, or commit or discard the ' +
      'changes in the slots named above; the dispatch is retried next cycle either way.'
    );
  }

  /**
   * Free a target path that a *dead* checkout is squatting on. An interrupted or
   * killed agent can leave its worktree de-registered-but-present — the
   * `.git/worktrees/<name>` admin entry gone, the folder still on disk — which the
   * porcelain list cannot see and `git worktree add` then refuses with
   * `fatal: '<dir>' already exists`. Since slot paths are deterministic, every retry
   * hits the same wall: the slot is wedged for good and the pool is one smaller.
   *
   * `git worktree prune` does *not* cover it — prune is the mirror case, an admin
   * entry whose directory vanished — which is why {@link ensure} runs prune ahead of
   * the slot scan and this separately.
   *
   * **Registered is untouchable.** The guard is the porcelain list, not the presence
   * of a `.git` file: a directory git still knows about is some agent's live
   * checkout, and yanking it mid-run is far worse than the collision. A registered
   * worktree standing here is not reachable through the pool scan either (it would
   * have been surveyed as a slot), so the `add` below failing loudly is the honest
   * answer.
   *
   * Reclaiming discards whatever the dead orphan still held. That is acceptable:
   * with no admin entry there is no branch or commit behind those files and no
   * workflow that could recover them — they are unreachable either way.
   *
   * **A lock is transient; `force` does not cover one.** `force` suppresses "it
   * isn't there", which is the opposite failure — a directory some *other live
   * process* holds open still throws `EBUSY`, and on Windows merely being a running
   * process's cwd is enough to hold it. So the removal retries (see
   * {@link RMDIR_RETRIES}), and what it throws when the retries run out names the
   * cause rather than the errno: the operator's next move is to go find the process,
   * and `EBUSY: resource busy or locked` does not tell them that is what to do.
   */
  private async reclaim(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await this.registered();
    if (entries.some((e) => e.path === dir)) return;
    // git may still half-track it; the removal below is the real reclaim, so a
    // refusal here ("not a working tree") is expected rather than a failure.
    await this.git(['worktree', 'remove', '--force', dir]).catch(() => {});
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: RMDIR_RETRIES, retryDelay: RMDIR_RETRY_DELAY_MS });
    } catch (err) {
      throw new Error(reclaimFailure(dir, err as NodeJS.ErrnoException));
    }
  }

  /**
   * The live worktrees, paths resolved: git's porcelain output is
   * forward-slashed even on Windows, so an unresolved path would never compare
   * equal to the `resolve`d slot paths every check here is built on.
   */
  private async registered(): Promise<WorktreeEntry[]> {
    const { stdout } = await this.git(['worktree', 'list', '--porcelain']);
    return parseWorktreeList(stdout).map((e) => ({ ...e, path: resolve(e.path) }));
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return runGit(this.repoRoot, args);
  }
}

/**
 * How a pool slot index becomes a directory name, in one place — the real manager
 * and {@link FakeWorktreeManager} both.
 *
 * It replaced `branchDirName`, which sanitised a *branch* into a directory name.
 * That mapping had to be shared because it could **collide**: with one directory per
 * branch, two branches sanitising onto one name landed on one checkout, and the fake
 * had to reproduce it. A slot is not named after what it holds, so there is nothing
 * left to collide and the sharing is now only so the two roots look alike.
 */
export function slotDirName(index: number): string {
  return `slot-${index}`;
}

/**
 * How many slots the pool gets beyond the concurrency cap.
 *
 * The cap bounds how many agents are *running*, and slots are held slightly longer
 * than that: from `ensure` until the agent's process is actually reaped, and by any
 * slot left carrying uncommitted changes by a run that failed. Sized to absorb that
 * rather than to hide a leak — a pool that needs more than this is a deployment that
 * should say so through `worktreePoolSize`.
 */
const POOL_SLACK = 2;

/** The pool bound a deployment that does not configure one runs on. */
export function defaultPoolSize(maxConcurrentAgents: number): number {
  return Math.max(1, maxConcurrentAgents) + POOL_SLACK;
}

/**
 * How many times the reclaim's `rmSync` retries, and how long it waits between
 * attempts — roughly a second in total. Node retries internally on exactly the
 * errors a *transient* holder produces (`EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY`,
 * `EPERM`), which is the distinction being drawn: a file still closing loses its
 * grip inside a second, and a process that has the directory as its cwd never
 * does. Sized to tell those apart rather than to outwait the second one — a
 * dispatch that hung on for a minute would be worse than the honest failure below.
 */
const RMDIR_RETRIES = 5;
const RMDIR_RETRY_DELAY_MS = 200;

/**
 * What a reclaim that lost says, in the operator's terms.
 *
 * The errno alone (`EBUSY: resource busy or locked, rmdir '<dir>'`) is a true
 * statement of the syscall and a dead end as a report: it is the same text whether
 * a virus scanner had the folder open for a moment or a shell an agent left behind
 * two days ago is sitting in it, and only the second one is going to still be there
 * next cycle. Since the retries have already ruled the first out by the time this
 * is built, it can say the thing that is actually true and name the next move.
 */
function reclaimFailure(dir: string, err: NodeJS.ErrnoException): string {
  const held = err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY';
  if (!held) return `Cannot reclaim the worktree directory ${dir}: ${err.message}`;
  return (
    `Cannot reclaim the worktree directory ${dir}: it is held open by another process (${err.code}), ` +
    `and was still held after ${RMDIR_RETRIES} retries over ` +
    `${(RMDIR_RETRIES * RMDIR_RETRY_DELAY_MS) / 1000}s. That is almost always a process an earlier agent ` +
    `started and left running — a shell, a watcher, a test runner — whose working directory is still ` +
    `inside it; on Windows being a live process's cwd is by itself enough to refuse the removal. ` +
    `Stop that process and the branch dispatches again on the next cycle; until then every dispatch ` +
    `onto it will fail here.`
  );
}

/**
 * What a dispatch asks the pool for: a **branch** to work on, or a **read-only**
 * checkout of a ref (issue #396).
 *
 * One type rather than two entry points with two policies, because the policy —
 * the lease, the survey, the bound, the refusal — is the same for both and is the
 * part that must not fork. All that discriminates them is what a prepared slot ends
 * up holding, which is `switch <branch>` on one arm and `switch --detach <commit>`
 * on the other.
 *
 * `name` is what the slot is leased under either way: a branch for the first,
 * and for the second a key that never becomes a ref — the task row's `branch`, the
 * branch gate's, and what `remove` is called with when the agent is reaped.
 */
type Request = { readOnly: false; name: string; base?: string } | { readOnly: true; name: string; of: string };

/**
 * What a slot holds when it holds a read-only checkout: whose it is, and which ref
 * it is a checkout **of**.
 *
 * Both fields do a job the pool has nothing else to answer with. `key` is what
 * `pool.held` is asked about, so a restart still knows a detached slot is somebody's
 * (there is no ref for it to read). `of` is what scopes the warm hand-over: two
 * read-only checkouts of one ref are the same tree, and of two different refs are
 * the stale-`dist/` bug the wipe exists for.
 */
interface Mark {
  key: string;
  of: string;
}

/** Where a slot's mark lives, relative to `worktreeRoot`. */
const MARKS_DIR = '.read-only';

/** A slot's mark, or null when it holds no read-only checkout (or an unreadable one). */
function readMark(path: string): Mark | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { key, of } = parsed as Partial<Mark>;
    return typeof key === 'string' && typeof of === 'string' ? { key, of } : null;
  } catch {
    // No mark, or one nothing can read: both mean the slot vouches for nothing, and
    // a full wipe is the answer to both.
    return null;
  }
}

/** How a request reads in a failure the operator has to act on. */
function describe(req: Request): string {
  return req.readOnly ? `read-only checkout ${req.name} of ${req.of}` : `branch ${req.name}`;
}

/** What {@link WorktreeManager.survey} found: see there for what each arm means. */
interface Survey {
  own: string | null;
  warm: string | null;
  spare: string | null;
  evictable: string | null;
  blocked: string[];
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** `refs/heads/x` as `x`, which is what every branch predicate here is asked about. */
function shortBranch(ref: string | null): string | null {
  if (ref === null) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Is `path` inside `root`? Both are already resolved when this is asked. */
function isUnder(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === '') {
      if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
      current = {};
    }
  }
  if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
  return entries;
}
