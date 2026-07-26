import type { ErrorRecorder } from '../errorLog.js';
import type { GitObserver } from '../git/gitObserver.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Plan, PlanPart, PullRequest, Task, WorldSnapshot } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { renderPlanComment } from './planComment.js';
import { bySlug, dependencyOf, dependencySatisfied, observePartPr, partBranch, planIssueNumber } from './parts.js';
import type { PlanningPolicy } from './planning.js';

interface PlanReconcilerDeps {
  store: Store;
  /** Branch reality. The seam stage 1 landed; this is its consumer. */
  git: GitObserver;
  /** Outbound seam, for the plan's status comment. */
  sink: ActionSink;
  planning: PlanningPolicy;
  defaultBranch: string;
  /**
   * Refresh the remote-tracking refs before reading them. Omitted = never fetch,
   * which is what tests injecting a scripted observer want (and what a harness with
   * no remote gets).
   */
  fetch?: () => Promise<void>;
  errors?: ErrorRecorder;
}

/**
 * Fold observed reality onto the plan-part rows, once per pulse, next to
 * `worldDiff`. **The store holds intent; the outside world stays the source of
 * truth** — tracking that only records what LubbDubb meant to do goes fictional
 * within a day (a human merges a part by hand, or closes its PR, and the store
 * still says `dispatched`).
 *
 * Two sources, good at different things:
 *
 * - **Git** for branch reality. It is the only source that sees a branch before a
 *   PR exists, and "has this part actually pushed" is precisely what a dependent
 *   stacks on. It cannot see a merge: `merge_pr` squashes, and a squash-merged
 *   branch has no ancestry link to its base.
 * - **The provider**, from the world snapshot, for PR and merge state.
 *
 * It runs *before* `Dispatcher.decide` in the same cycle, so a part it moves to
 * `ready` is dispatchable immediately — intended, and safe because every fold is
 * idempotent: each writes a status derived from the observation, never toggled
 * relative to the previous one.
 */
export class PlanReconciler {
  private lastFetchAt = 0;
  private lastFetchError: string | null = null;

  constructor(private readonly deps: PlanReconcilerDeps) {}

  async reconcile(world: WorldSnapshot): Promise<void> {
    if (!this.deps.planning.enabled) return; // off means off, including for a stale DB
    // `awaiting_approval` is reconciled too. It dispatches nothing, but readiness
    // is what the "Up next" queue renders as held — an unreconciled plan's parts
    // are all still `pending`, so the operator would be asked to approve a
    // decomposition whose parts were invisible everywhere but the panel. (A
    // replan of a live plan sits here as well, and its in-flight parts must keep
    // being folded while the amendment waits on a human.)
    const plans = this.deps.store
      .listPlans()
      .filter((p) => p.status === 'active' || p.status === 'complete' || p.status === 'awaiting_approval');
    if (plans.length === 0) return; // nothing to observe — don't pay for a fetch

    await this.maybeFetch();
    const tasks = this.deps.store.listTasks();
    for (const plan of plans) {
      await this.reconcilePlan(plan, world.pullRequests, world.closedPullRequests ?? [], tasks);
    }
  }

  /** Refresh remote-tracking refs, floored by `planning.gitFetchIntervalMs`. */
  private async maybeFetch(): Promise<void> {
    const fetch = this.deps.fetch;
    if (!fetch) return;
    const now = Date.now();
    if (now - this.lastFetchAt < this.deps.planning.gitFetchIntervalMs) return;
    this.lastFetchAt = now;
    try {
      await fetch();
      this.lastFetchError = null;
    } catch (err) {
      // Once per distinct failure: a repo with no `origin` would otherwise fill the
      // Errors panel with the same line every pulse.
      const message = (err as Error).message;
      if (message === this.lastFetchError) return;
      this.lastFetchError = message;
      this.deps.errors?.record({ source: 'cycle', message: `Plan reconciliation could not fetch: ${message}` });
    }
  }

  private async reconcilePlan(plan: Plan, prs: PullRequest[], closedPrs: PullRequest[], tasks: Task[]): Promise<void> {
    const { store } = this.deps;
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) return;
    const parts = store.listPlanParts(plan.id);
    if (parts.length === 0) return;

    // `refs/heads/issue/12` and `refs/heads/issue/12/<slug>` cannot coexist — git
    // stores refs as files, so the flat branch blocks the directory. An issue worked
    // as `single` first and replanned to `parts` has exactly that branch, and every
    // part branch would fail to create with a git error nobody can act on. Say it
    // once, plainly, and park the parts that haven't been cut yet.
    const flat = await this.deps.git.presence(issueBranch(issueNumber));
    const collision = flat.local || flat.remote;

    const next = new Map<string, Partial<PlanPart>>();
    for (const part of parts) {
      // A retired part is out of the plan: an amendment dropped it before anything
      // was started for it, so there is no reality to fold on and nothing that
      // should quietly bring it back.
      if (part.status === 'retired') continue;
      const patch = this.foldPr(part, issueNumber, prs, closedPrs) ?? this.foldStalled(part, tasks);
      if (patch) next.set(part.slug, patch);
    }
    // Applied to a working copy so readiness below sees this pulse's observations,
    // not last pulse's — a dependency that merged this cycle unblocks its dependent
    // in the same cycle.
    const observed = parts.map((p) => ({ ...p, ...next.get(p.slug) }) as PlanPart);
    const index = bySlug(observed);

    for (const part of observed) {
      if (part.status !== 'pending' && part.status !== 'ready' && part.status !== 'blocked') continue;
      const status = collision ? 'blocked' : await this.readiness(part, index, issueNumber);
      if (status !== part.status) next.set(part.slug, { ...next.get(part.slug), status });
    }

    let changed = false;
    for (const part of parts) {
      const patch = next.get(part.slug);
      if (!patch || !differs(part, patch)) continue;
      store.updatePlanPart(part.id, patch);
      changed = true;
    }
    if (changed && collision) {
      this.deps.errors?.record({
        source: 'cycle',
        message:
          `Plan for issue #${issueNumber} is blocked: the branch ${issueBranch(issueNumber)} exists, and git cannot ` +
          `create ${partBranch(issueNumber, '<part>')} while it does (refs are files, not directories). ` +
          `Delete or rename ${issueBranch(issueNumber)} to unblock the parts.`,
      });
    }

    const rolled = store.rollUpPlanStatus(plan.id);
    const current = rolled ?? plan;
    // Write the status comment when there is news — the plan appearing (no comment
    // yet), a part moving, or the plan completing. It's edited in place, so this is
    // one living comment rather than a stream, which is what keeps it off the
    // auto-send gate: it's mechanical bookkeeping, not authored prose.
    //
    // Not while the plan is awaiting approval: the comment is the plan's progress
    // channel, and an unapproved decomposition has no progress to report — posting
    // it would announce a commitment on the tracker that the operator has not made,
    // and a refusal would then leave that announcement standing (a refused plan is
    // `single`, which this loop never revisits).
    if (current.status !== 'awaiting_approval' && (current.statusCommentRef === null || changed || rolled)) {
      await this.writeStatusComment(current, store.listPlanParts(plan.id), issueNumber);
    }
  }

  /**
   * What the provider says about a part's PR — see {@link observePartPr} for the
   * ordering, which is the whole substance of this fold.
   *
   * The reason it's worth naming here: absence used to be read as **merged**
   * unconditionally, because both providers list only open PRs and the world model
   * had no closed state to tell a merge from an abandonment. That inference is now
   * the *fallback* rather than the only reading — inside `closedPrWindowMs` the
   * closed list says which it was, and a part whose PR was abandoned goes back to
   * `ready` instead of silently completing its plan. Outside the window nothing
   * changes, deliberately: a PR that merged last week is still absent, and reading
   * that as un-merged would be a far worse bug than the one this fixes.
   */
  private foldPr(
    part: PlanPart,
    issueNumber: number,
    prs: PullRequest[],
    closedPrs: PullRequest[],
  ): Partial<PlanPart> | null {
    return observePartPr(part, part.branch ?? partBranch(issueNumber, part.slug), prs, closedPrs);
  }

  /**
   * A part whose agent is gone without leaving a PR. Back to `ready` so it is
   * re-dispatched — through the per-part origin's cooldown and attempt cap, which
   * escalates rather than looping once the attempts are spent.
   */
  private foldStalled(part: PlanPart, tasks: Task[]): Partial<PlanPart> | null {
    if (part.status !== 'dispatched') return null;
    const task = tasks.find((t) => t.id === part.taskId);
    const live = task && (task.status === 'queued' || task.status === 'running' || task.status === 'waiting');
    return live ? null : { status: 'ready' };
  }

  /** `ready` once every dependency has pushed a branch worth stacking on, else `pending`. */
  private async readiness(
    part: PlanPart,
    index: Map<string, PlanPart>,
    issueNumber: number,
  ): Promise<PlanPart['status']> {
    const dep = dependencyOf(part, index);
    if (!dep) return 'ready';
    const branch = dep.branch ?? partBranch(issueNumber, dep.slug);
    const pushed = await this.deps.git.hasCommitsBeyond(branch, this.deps.defaultBranch);
    return dependencySatisfied(dep, () => pushed) ? 'ready' : 'pending';
  }

  private async writeStatusComment(plan: Plan, parts: PlanPart[], issueNumber: number): Promise<void> {
    try {
      const result = await this.deps.sink.upsertIssueComment({
        number: issueNumber,
        body: renderPlanComment(plan, parts),
        commentRef: plan.statusCommentRef,
      });
      if (result.ref && result.ref !== plan.statusCommentRef) this.deps.store.setPlanStatusComment(plan.id, result.ref);
    } catch (err) {
      // Progress reporting must never take the pulse down with it — the plan keeps
      // running, and the failure shows up in the Errors panel.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Could not update the plan status comment on #${issueNumber}: ${(err as Error).message}`,
      });
    }
  }
}

/** Does a patch actually move the row? Keeps reconciliation writes to real transitions. */
function differs(part: PlanPart, patch: Partial<PlanPart>): boolean {
  return (Object.keys(patch) as (keyof PlanPart)[]).some((key) => patch[key] !== part[key]);
}
