import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ErrorRecorder } from '../errorLog.js';
import { runGit, resolveCommit } from '../git/gitCli.js';

/**
 * Git's write side, as the one seam the executor depends on — the seam a test must
 * inject a fake for, or it cuts a real branch in `repoRoot` and never deletes it.
 * Deliberately narrow: `ensure`/`ensureReadOnly`/`remove`/`deleteBranch` is the whole
 * of what {@link ActionExecutor} and the reap ask for. → `docs/spec/09-execution.md#worktrees`
 */
export interface Worktrees {
  /**
   * Path to a worktree for `branch`, leasing a pool slot for it. A slot already on the
   * branch is handed back with everything in it; any other slot is wiped first. Throws
   * when no slot is free — the dispatch is rejected rather than queued behind a directory.
   */
  ensure(branch: string, base?: string): Promise<string>;
  /**
   * Path to a read-only checkout of `of`, leased under `key` — for dispatches that need
   * a repository and no branch (appraisal, assessment, validation), which would
   * otherwise mint one unreapable ref each. Checked out detached, so there is no ref.
   */
  ensureReadOnly(key: string, of: string): Promise<string>;
  /**
   * The local run's one checkout, detached at whatever `ref` resolves to. Not a pool
   * slot: one fixed directory under `localRunRoot`, outside `worktreeRoot`; ignored
   * files survive a ref change (`-fd`, not `-ffdx`); no lease, since there is only one.
   * An unresolvable `ref` throws rather than falling back to HEAD. → `docs/spec/23-local-runs.md#the-checkout`
   */
  ensurePreview(ref: string): Promise<{ dir: string; commit: string }>;
  /**
   * Where {@link ensurePreview} would put the checkout, without touching it. A refresh
   * asks this first, since `ensurePreview` is a `reset --hard` + `clean -fd` and not
   * worth paying for when the tip has not moved.
   */
  previewCommit(ref: string): Promise<string>;
  /** Release the lease `ensure` or {@link ensureReadOnly} took. The directory stays, so the same work coming back starts warm. */
  remove(branch: string): Promise<void>;
  /** Release the lease and the local branch ref — the local half of the reap after a pull request merges. A no-op if the branch does not exist locally. */
  deleteBranch(branch: string): Promise<void>;
}

/**
 * A bounded pool of git worktree directories, leased to branches on demand. A slot left
 * standing on its branch keeps everything git ignores, so a branch that comes back
 * starts warm. Reuse is scoped to the branch: a slot handed to a *different* branch is
 * wiped ({@link handOver}), and the lease is the only thing keeping two agents out of
 * one directory. A read-only checkout is a slot like any other, detached rather than
 * switched. Desk tasks never call any of this. → `docs/spec/09-execution.md#worktrees`
 */
export class WorktreeManager implements Worktrees {
  /**
   * The slot this run handed to each branch, until {@link remove} releases it. In
   * memory on purpose — this is only half the lease, covering the settle→reaped window
   * a durable reading cannot; the other half is `pool.held`, which survives a restart.
   */
  private readonly leases = new Map<string, string>();

  constructor(
    private readonly repoRoot: string,
    private readonly worktreeRoot: string,
    private readonly pool: {
      /**
       * Hard bound on slot directories under `worktreeRoot`. Read on every acquire,
       * never snapshotted: a cap raised past a frozen bound rejects every dispatch
       * above the old number forever, with nothing red. → `docs/spec/09-execution.md#exhaustion`
       */
      readonly size: number;
      /**
       * Whether the harness still has work in flight on a branch. This is what makes
       * the lease survive a restart: a restored orphan's task is still outstanding, so
       * its slot reads as held rather than being cleaned under the agent.
       */
      held: (branch: string) => boolean;
    },
    /** `localRunRoot` — the local run's one checkout, not under `worktreeRoot`. Required so the wiring mistake is caught by the compiler. */
    private readonly previewRoot: string,
    /** Where {@link salvage} reports what it moved and what it could not — the only part of the pool acting on a slot with no dispatch of its own. */
    private readonly errors?: ErrorRecorder,
  ) {}

  /**
   * Return the path to a worktree for `branch`, leasing a slot — the writable shape.
   * Reuse comes first and `base` is then ignored entirely: `ensure(branch, base)` does
   * not guarantee the branch is based on `base`, only where one that did not exist starts.
   * → `docs/spec/09-execution.md#worktrees`
   */
  ensure(branch: string, base?: string): Promise<string> {
    return this.acquire({ readOnly: false, name: branch, base });
  }

  /**
   * A detached checkout of `of`, leased under `key` — see {@link Worktrees.ensureReadOnly}.
   * `of` is required where `ensure`'s `base` is not, since the repo root's HEAD is
   * whatever an operator last left checked out.
   */
  ensureReadOnly(key: string, of: string): Promise<string> {
    return this.acquire({ readOnly: true, name: key, of });
  }

  /**
   * The local run's one checkout, detached at `ref` — see {@link Worktrees.ensurePreview}.
   * Outside {@link acquire} entirely: no survey, no lease, no eviction. The commit is
   * resolved before the directory is touched, so an unresolvable ref leaves it as it was.
   */
  previewCommit(ref: string): Promise<string> {
    return this.startPoint('the local run', ref);
  }

  async ensurePreview(ref: string): Promise<{ dir: string; commit: string }> {
    const commit = await this.startPoint('the local run', ref);
    const dir = resolve(this.previewRoot);
    // Whether the directory is there, never whether `git worktree list` names it: git
    // reports the canonical path, and a short-name TEMP root on Windows resolves
    // differently for the same directory than `worktree add` would report it as existing.
    if (!existsSync(dir)) {
      mkdirSync(dirname(dir), { recursive: true });
      await this.git(['worktree', 'add', '--detach', dir, commit]);
      return { dir, commit };
    }
    // Detach before the reset, and reset rather than switch: `switch` refuses on a
    // tracked edit, and `reset --hard` on a branch would rewind *that branch*.
    await runGit(dir, ['checkout', '--quiet', '--detach']);
    await runGit(dir, ['reset', '--hard', '--quiet', commit]);
    // No `-x`: untracked junk goes, `node_modules` stays, so the next start is warm.
    await runGit(dir, ['clean', '-fd']);
    return { dir, commit };
  }

  /**
   * Lease a slot for `req` — the one path both {@link ensure} and {@link ensureReadOnly}
   * take, checked once rather than twice. In order: (1) the slot `req` already holds;
   * (2) for read-only, a free slot already checked out at the same ref; (3) a spare,
   * holding nothing anybody can come back for; (4) a new slot while below the pool
   * bound, ahead of eviction so a live branch's tree is never burnt for nothing; (5) the
   * first evictable slot, wiped and switched ({@link handOver}); (6) failing all of
   * those, {@link salvage} moves uncommitted work off stranded slots and the ladder is
   * walked once more. With none of the six this throws, as does an unresolvable
   * `base`/`of` and a switch git refuses — never a silent fallback to a fresh directory,
   * which would put two agents in one tree. `salvaged` marks the second walk and stops recursion.
   * → `docs/spec/09-execution.md#exhaustion`
   */
  private async acquire(req: Request, salvaged?: SalvageReport): Promise<string> {
    // Must run before the slot scan: a vanished directory otherwise leaves an admin
    // entry that reads as occupied forever, shrinking the pool with nothing to say so.
    await this.git(['worktree', 'prune']).catch(() => {});

    if (!req.readOnly) {
      const existing = await this.findExistingSlot(req.name);
      if (existing) return this.lease(req.name, existing);
      // Checked out somewhere the pool does not own — in practice an operator's own
      // main worktree. Refused by name so the operator gets an actionable sentence.
      const outside = await this.findExisting(req.name);
      if (outside !== null) throw new Error(this.checkedOutElsewhere(req.name, outside));
    }

    mkdirSync(this.worktreeRoot, { recursive: true });
    const slots = await this.slots();
    const survey = await this.survey(slots, req);
    // A read-only key's own slot, which git cannot answer for: nothing is checked out
    // under that name, so the mark and the lease are all there is to go on.
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

    if (survey.evictable !== null) {
      await this.handOver(survey.evictable, req);
      return this.lease(req.name, survey.evictable);
    }

    const report = salvaged ?? (await this.salvage(survey.blocked));
    if (salvaged === undefined && report.freed > 0) return this.acquire(req, report);
    throw new Error(this.exhausted(req, survey.blocked, report, slots));
  }

  /**
   * Path of any registered worktree checked out on the branch, or null — the repo's own
   * main worktree included. The wide reading {@link deleteBranch} wants; {@link acquire}
   * must use {@link findExistingSlot} instead, or an agent is handed a directory the pool does not own.
   */
  async findExisting(branch: string): Promise<string | null> {
    const entries = await this.registered();
    const match = entries.find((e) => e.branch === branch || e.branch === `refs/heads/${branch}`);
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  /**
   * Path of a pool slot checked out on the branch, or null — `ensure`'s reuse arm.
   * `registered()` includes the repository's own main worktree, so this scopes to the
   * pool: handing the main worktree to a dispatch would run an agent invisible to the bound and salvage alike.
   */
  private async findExistingSlot(branch: string): Promise<string | null> {
    const entries = await this.registered();
    const match = entries.find(
      (e) => isUnder(this.worktreeRoot, e.path) && (e.branch === branch || e.branch === `refs/heads/${branch}`),
    );
    if (match && existsSync(match.path)) return match.path;
    return null;
  }

  /**
   * Release the lease. Nothing is deleted — the slot stays on the branch so it comes
   * back warm; a hand-over to another branch is what wipes it. Must not go on holding
   * the slot, or the pool shrinks by one per failure.
   */
  remove(branch: string): Promise<void> {
    this.leases.delete(branch);
    return Promise.resolve();
  }

  /**
   * Release the lease and then delete the branch ref, for a branch whose pull request
   * has merged. `-D`, not `-d`: a squash-merged branch has no ancestry link to its base.
   * The slot is detached, not removed, so the warm tree stands for the next occupant;
   * the repo's own main worktree is refused by name ({@link reapBlockedByCheckout}).
   *
   * The lease is asked first, and a held slot is refused rather than damaged — the
   * durable `reapableBranches` guard evaporates the instant a task settles while the
   * agent's process is still in the directory, and freeing the slot in that window
   * hands a live process's tree to the next branch. The throw is handled:
   * `BranchReapDesk` retries without writing `branch_reaps`.
   */
  async deleteBranch(branch: string): Promise<void> {
    const holding = await this.findExisting(branch);
    if (holding !== null && isUnder(this.worktreeRoot, holding)) {
      // Both halves, per {@link holder}: the in-memory lease covers the
      // settle→reaped window, `pool.held` covers the restart.
      const heldBy = this.leaseOn(holding) ?? (this.pool.held(branch) ? branch : null);
      if (heldBy !== null) {
        throw new Error(
          `Cannot reap ${branch}: its slot ${holding} is still held by ${heldBy}, whose process may still be ` +
            "sitting in that directory. Detaching it now would hand a live agent's tree to the next branch. " +
            'The reap is retried on the next pulse.',
        );
      }
    }
    await this.remove(branch);
    if (holding === resolve(this.repoRoot)) throw new Error(this.reapBlockedByCheckout(branch, holding));
    if (holding !== null) await runGit(holding, ['switch', '--detach']);
    if (!(await this.branchExists(branch))) return;
    await this.git(['branch', '-D', branch]);
  }

  /** Record the lease and hand the path back — the one place a lease is taken. */
  private lease(branch: string, dir: string): string {
    this.leases.set(branch, dir);
    return dir;
  }

  /**
   * The free slots worth taking, in the flavours {@link acquire} chooses between, and
   * why each of the others was not free. own: this request already holds it. warm:
   * already a read-only checkout of the same ref. spare: holds nothing anybody can come
   * back for. evictable: free but still carrying something, why {@link acquire} grows
   * the pool before reaching for one.
   *
   * A slot carrying uncommitted tracked changes is never handed to another branch — `git
   * switch` carries non-conflicting edits across, so a failed agent's half-finished work
   * would land on an unrelated branch and be committed there. Each blocked slot's reason
   * is collected as it goes, since the exhaustion refusal is the operator's only handle
   * on the pool; `stuck` is set only on the arm that has established nothing holds the
   * slot, which is what {@link salvage} is allowed to touch.
   */
  private async survey(slots: WorktreeEntry[], req: Request): Promise<Survey> {
    const blocked: Blocked[] = [];
    let warm: string | null = null;
    let spare: string | null = null;
    let evictable: string | null = null;
    for (const slot of slots) {
      const mark = readMark(this.markPath(slot.path));
      const holder = this.holder(slot, mark);
      if (holder !== null) {
        // Its own holder is the reuse arm, not a blocker: a second task under one
        // name shares the checkout rather than fighting over it.
        if (holder === req.name) return { own: slot.path, warm, spare, evictable, blocked };
        blocked.push({ path: slot.path, reason: `work in flight on ${holder}`, stuck: false });
        continue;
      }
      if (await this.dirty(slot.path)) {
        const on = shortBranch(slot.branch) ?? 'a detached HEAD';
        blocked.push({ path: slot.path, reason: `uncommitted changes on ${on}`, stuck: true });
        continue;
      }
      if (req.readOnly && mark !== null && mark.of === req.of) {
        warm ??= slot.path;
        continue;
      }
      const occupant = shortBranch(slot.branch);
      if (mark === null && (occupant === null || !(await this.branchExists(occupant)))) {
        spare ??= slot.path;
        // A spare beats everything a writable request can reach below it. A read-only
        // request scans on: a warm slot beats it.
        if (!req.readOnly) return { own: null, warm, spare, evictable, blocked };
        continue;
      }
      evictable ??= slot.path;
    }
    return { own: null, warm, spare, evictable, blocked };
  }

  /**
   * The name still holding this slot, or null — the lease, asked. The mark is why a
   * read-only slot survives a restart: a detached checkout has no ref for `pool.held` to
   * ask about, so without it a restored appraiser's tree reads as a spare and is wiped under the agent still sitting in it.
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
   * Move the uncommitted work stranding each stuck slot onto a ref of its own, and hand
   * the emptied slots back to the pool. Without it the pool silts up: a slot carrying
   * uncommitted tracked changes is refused by {@link survey} forever, so a failed agent
   * costs a directory permanently.
   *
   * Runs only on {@link acquire}'s dead end, where the survey's `git status` has already
   * been paid for. It never decides what is worth keeping — `git stash push
   * --include-untracked` takes tracked edits, the index and new files, but not ignored
   * ones, leaving dependency trees on disk. A stash rather than a commit, so a detached
   * HEAD needs no special case.
   *
   * The stash is copied to `refs/lubbdubb/salvage/<slot>/<sha>` and taken back off the
   * stack: a ref in our own namespace moves for nobody, where the operator's stash stack
   * shifts under whoever reads it next. Content-addressed, so salvaging twice cannot overwrite the first.
   */
  private async salvage(blocked: Blocked[]): Promise<SalvageReport> {
    const notes: string[] = [];
    let freed = 0;
    for (const slot of blocked) {
      // A held slot is somebody's, lease or mark — nothing reaches past the lease,
      // least of all something with no dispatch behind it.
      if (!slot.stuck) continue;
      try {
        const ref = await this.stash(slot.path);
        freed += 1;
        notes.push(ref === null ? `${slot.path} (nothing left to save)` : `${slot.path} → ${ref}`);
        if (ref !== null) this.errors?.record({ source: 'cycle', message: salvaged(slot.path, ref) });
      } catch (err) {
        // Not swallowed and not fatal: the slot stays blocked and the refusal below
        // repeats this.
        const message = `Cannot reclaim the worktree slot ${slot.path}: ${(err as Error).message}`;
        notes.push(message);
        this.errors?.record({ source: 'cycle', message });
      }
    }
    return { freed, notes };
  }

  /**
   * Stash everything uncommitted in `dir` onto a ref of the pool's own, and return that
   * ref, or null when there was nothing to take. The tip is read either side of the push
   * rather than the output parsed: "No local changes to save" is a success exit, and
   * dropping on that would take the previous entry, which is somebody else's.
   */
  private async stash(dir: string): Promise<string | null> {
    const before = await this.stashTip();
    await runGit(dir, ['stash', 'push', '--include-untracked', '--message', `lubbdubb: reclaimed ${basename(dir)}`]);
    const tip = await this.stashTip();
    if (tip === null || tip === before) return null;
    const ref = `${SALVAGE_REFS}/${basename(dir)}/${tip.slice(0, 12)}`;
    // The ref before the drop, so a failure between them leaves the work on the stack.
    await this.git(['update-ref', ref, tip]);
    if ((await this.stashTip()) === tip) await this.git(['stash', 'drop']);
    return ref;
  }

  /** The stash stack's top commit, or null when nothing has ever been stashed. */
  private async stashTip(): Promise<string | null> {
    try {
      const { stdout } = await this.git(['rev-parse', '--verify', '--quiet', 'refs/stash']);
      return stdout.trim() || null;
    } catch {
      // `--verify` exits non-zero for a missing ref, which reads as "nothing on the stack".
      return null;
    }
  }

  /**
   * Wipe a free slot back to a fresh checkout and switch it onto what `req` asks for.
   * `-ffdx`: this runs only for work the slot is not already holding, so everything in
   * it answers some other branch's source; `-x` takes ignored output, the second `-f`
   * takes a nested repository.
   *
   * One hand-over keeps the ignored files: a read-only checkout of a ref handed to
   * another of the same ref, where the build state answers the same source — the mark is
   * the whole of the evidence, written only by a read-only hand-over.
   *
   * Ordering: the mark is cleared first, so a failure leaves a slot claiming nothing; the
   * wipe precedes the switch, which refuses when an untracked file would be overwritten;
   * the start point is resolved before any of it.
   *
   * The reset forms must stay unreachable: `git switch -C` / `checkout -B` would reset an
   * existing branch to the start point, discarding commits a re-dispatch or retry left on
   * it with nothing red. Existence is checked first, so create is only reached for a
   * branch that does not exist. → `docs/spec/09-execution.md#handing-a-slot-over`
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
    // Otherwise a slot minted onto a dead one's path inherits its mark, and reads as
    // a read-only tree nobody prepared.
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
   * How a prepared slot is pointed at what it will hold — detached at a commit for
   * read-only, switched onto a branch otherwise. Resolved before the slot is touched;
   * the create form is only reachable for a branch that does not exist, which keeps
   * `switch -C` unreachable — see {@link handOver}.
   */
  private async switchOnto(req: Request): Promise<string[]> {
    if (req.readOnly) return ['switch', '--quiet', '--detach', await this.startPoint(req.name, req.of)];
    if (await this.branchExists(req.name)) return ['switch', '--quiet', req.name];
    return ['switch', '--quiet', '-c', req.name, await this.startPoint(req.name, req.base)];
  }

  /**
   * Where a branch that does not exist yet starts, or where a read-only checkout is
   * pinned — as a commit. An omitted `base` means the repo root's HEAD, named explicitly
   * because a pooled slot's own HEAD is the previous occupant's and would silently mis-base a reused slot's branch.
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
   * Read, write or clear a slot's read-only mark. Beside the slots rather than inside
   * one: a file in the worktree is a stray `clean -ffdx` would take, and one in git's
   * admin directory is the harness writing into git's bookkeeping. A lost mark degrades to a full wipe.
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
   * Where the next slot would go, or null when the pool is at its bound. The lowest
   * unused index, so a pool that lost a slot fills the hole. A pre-pool deployment's
   * branch-named directory is a registered worktree under the same root, so it counts
   * toward the bound and is reused like any other slot.
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

  /** Why a branch the pool does not hold cannot be leased — a checkout outside `worktreeRoot` standing on it. Executor records a rejected dispatch and retries next pulse. */
  private checkedOutElsewhere(branch: string, path: string): string {
    return (
      `Cannot lease a worktree for ${branch}: it is already checked out at ${path}, which is not a pool slot ` +
      `(the pool is ${this.worktreeRoot}). Git refuses to check one branch out twice, and this checkout is not ` +
      `the harness's to switch — it is most likely the repository's own working copy. Switch it to another ` +
      `branch and the dispatch goes through on the next pulse.`
    );
  }

  /** What the reap says when the branch is checked out in the repository's own working copy — the counterpart to {@link checkedOutElsewhere}. */
  private reapBlockedByCheckout(branch: string, path: string): string {
    return (
      `Cannot reap ${branch}: it is checked out at ${path}, the repository's own working copy, which is not ` +
      `the harness's to switch — detaching it would move an operator off their branch without asking. Git ` +
      `refuses to delete a branch that is checked out, so the local ref and the remote copy both stay. Switch ` +
      `that checkout to another branch and the reap completes on the next pulse.`
    );
  }

  /** What an exhausted pool says: what {@link salvage} did, and the directories under `worktreeRoot` that are not registered worktrees. */
  private exhausted(req: Request, blocked: Blocked[], salvage: SalvageReport, slots: WorktreeEntry[]): string {
    const strays = this.strays(slots);
    return (
      `No free worktree slot for ${describe(req)}: all ${this.pool.size} slots under ${this.worktreeRoot} are ` +
      `unavailable — ${blocked.map((b) => `${b.path} (${b.reason})`).join('; ')}. ` +
      (salvage.notes.length > 0 ? `Reclaim: ${salvage.notes.join('; ')}. ` : '') +
      'A slot is held while the harness has work in flight on the branch checked out in it, and a slot carrying ' +
      'uncommitted changes is stashed onto a salvage ref and reclaimed — so one still named above is one the ' +
      'stash itself refused. The bound follows the live agent cap, so raising the cap raises it too; the ' +
      'dispatch is retried next cycle either way.' +
      (strays.length === 0
        ? ''
        : ` Costing disk but not slots: ${strays.length} ${strays.length === 1 ? 'directory' : 'directories'} ` +
          `under ${this.worktreeRoot} that git no longer knows about (${listed(strays)}). \`git worktree prune\` ` +
          'has already run, so nothing here will ever reach them again and they are safe to delete by hand; ' +
          'the harness will not, because this root is an operator setting and an unguarded delete under a ' +
          'mistyped one is unrecoverable.')
    );
  }

  /** Directories under `worktreeRoot` that are not registered worktrees — a killed agent's leftovers, or a pre-pool checkout. Only asked on the refusal path. */
  private strays(slots: WorktreeEntry[]): string[] {
    const known = new Set(slots.map((e) => e.path));
    return readdirSync(this.worktreeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== MARKS_DIR)
      .map((e) => resolve(this.worktreeRoot, e.name))
      .filter((path) => !known.has(path));
  }

  /**
   * Free a target path that a *dead* checkout is squatting on: an interrupted agent can
   * leave a worktree de-registered-but-present, which the porcelain list cannot see and
   * `git worktree add` refuses with "already exists". Slot paths are deterministic, so
   * every retry hits the same wall without this.
   *
   * Registered is untouchable — the guard is the porcelain list: a directory git still
   * knows about is some agent's live checkout. A lock is transient and `force` does not
   * cover a live process holding the directory (`EBUSY`), so removal retries
   * ({@link RMDIR_RETRIES}) and then throws a message naming the cause.
   */
  private async reclaim(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await this.registered();
    if (entries.some((e) => e.path === dir)) return;
    // git may still half-track it; the removal below is the real reclaim, so a
    // refusal here is expected.
    await this.git(['worktree', 'remove', '--force', dir]).catch(() => {});
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: RMDIR_RETRIES, retryDelay: RMDIR_RETRY_DELAY_MS });
    } catch (err) {
      throw new Error(reclaimFailure(dir, err as NodeJS.ErrnoException));
    }
  }

  /** The live worktrees, paths resolved: git's porcelain output is forward-slashed even on Windows, and must match the `resolve`d slot paths every check is built on. */
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

/** How a pool slot index becomes a directory name — the real manager and {@link FakeWorktreeManager} share it so the two roots look alike. */
export function slotDirName(index: number): string {
  return `slot-${index}`;
}

/** How many slots the pool gets beyond the concurrency cap — held from `ensure` until reaped, and while a dirty slot waits to be salvaged. Sized to absorb that, never to hide a leak. */
const POOL_SLACK = 2;

/**
 * The pool bound, derived from the live cap. A pool below the cap starves the fleet
 * (every dispatch above the lower number rejected for want of a directory, with nothing
 * red); above it is disk nothing can lease. Called on every acquire.
 */
export function defaultPoolSize(cap: number): number {
  return Math.max(1, cap) + POOL_SLACK;
}

/** How many times the reclaim's `rmSync` retries and how long it waits — roughly a second, sized to tell a transient holder from a live process's cwd. */
const RMDIR_RETRIES = 5;
const RMDIR_RETRY_DELAY_MS = 200;

/** What a reclaim that lost says, naming the likely cause once the retries have ruled out a transient hold. */
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
 * What a dispatch asks the pool for: a branch to work on, or a read-only checkout of a
 * ref. One type rather than two entry points, since the policy is the same for both.
 * `name` is what the slot is leased under either way — a branch on one arm, a key that
 * never becomes a ref on the other.
 */
type Request = { readOnly: false; name: string; base?: string } | { readOnly: true; name: string; of: string };

/**
 * What a slot holds when it holds a read-only checkout: whose it is, and which ref it is
 * a checkout of. `key` is what `pool.held` is asked about, so a restart knows a detached
 * slot is somebody's; `of` scopes the warm hand-over.
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
    // No mark, or an unreadable one: the slot vouches for nothing, so a full wipe.
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
  blocked: Blocked[];
}

/** A slot neither free nor reusable, and which of the two reasons it was. */
interface Blocked {
  path: string;
  /** How it reads in the refusal, as the parenthetical after the path. */
  reason: string;
  /** Free of every holder and stranded only on uncommitted work — the one shape {@link WorktreeManager.salvage} may touch. */
  stuck: boolean;
}

/** What one {@link WorktreeManager.salvage} pass did, for the operator and the refusal. */
interface SalvageReport {
  /** How many slots it handed back to the pool. */
  freed: number;
  /** One line per stranded slot: where its work went, or why it could not be moved. */
  notes: string[];
}

/** Where salvaged work lands. Outside `refs/heads`, so it is not a branch to anything that reads branches. `git for-each-ref refs/lubbdubb/salvage` lists them and `git stash apply <ref>` puts one back. */
const SALVAGE_REFS = 'refs/lubbdubb/salvage';

/** What the error log says about work the pool took off a slot to keep the fleet moving. */
function salvaged(dir: string, ref: string): string {
  return (
    `Reclaimed worktree slot ${dir}, which was stranded carrying uncommitted changes. Nothing was discarded: ` +
    `its tracked edits, staged state and new files are stashed at ${ref} (\`git stash apply ${ref}\`). Ignored ` +
    'files are not stashed — a dependency tree does not belong in a git object, and the slot handles its own ' +
    "under the pool's usual rules. A slot needing this after every dispatch is a repository with tracked files " +
    'a build rewrites: untracking those is the fix, and until then this is where each copy goes.'
  );
}

/** Up to five paths named, then a count — a pool that lost thirteen must not fill the log with them. */
function listed(paths: string[]): string {
  const named = paths.slice(0, STRAYS_NAMED);
  const rest = paths.length - named.length;
  return rest === 0 ? named.join(', ') : `${named.join(', ')}, and ${rest} more`;
}

const STRAYS_NAMED = 5;

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
