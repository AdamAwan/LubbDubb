import type { ErrorRecorder } from '../errorLog.js';
import type { BranchPresence, GitObserver } from '../git/gitObserver.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Plan, PlanPart, PlanPartBlocker, PullRequest, TaskSummary, WorldSnapshot } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { renderPlanComment } from './planComment.js';
import { type PrRefStyle } from '../prRef.js';
import {
  bySlug,
  dependenciesOf,
  dependencySatisfied,
  observePartPr,
  partBranch,
  partIsHuman,
  partSettled,
  planIssueNumber,
} from './parts.js';
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
   * How the configured provider links a pull request in prose — the status
   * comment names each part's PR, and this comment is published on the tracker.
   * Omitted means `#`, which is right everywhere but Azure. → `src/prRef.ts`
   */
  prRefStyle?: PrRefStyle;
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
 * `worldDiff`. The store holds intent; the outside world stays the source of
 * truth. Two sources: git for branch reality (sees a branch before a PR
 * exists, but not a squash merge), and the provider's snapshot for PR/merge
 * state. Runs before `Dispatcher.decide` in the same cycle, so a part moved to
 * `ready` is dispatchable immediately. Safe because every fold is idempotent.
 */
export class PlanReconciler {
  private lastFetchAt = 0;
  private lastFetchError: string | null = null;
  /** The last status-comment body sent per plan — see {@link PlanReconciler.writeStatusComment}. */
  private readonly lastComment = new Map<string, string>();

  constructor(private readonly deps: PlanReconcilerDeps) {}

  async reconcile(world: WorldSnapshot): Promise<void> {
    // `awaiting_approval` is reconciled too: it dispatches nothing, but its parts
    // would otherwise stay `pending` and invisible in "Up next" — and a replan of a
    // live plan sits here with in-flight parts that must keep being folded.
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

  private async reconcilePlan(
    plan: Plan,
    prs: PullRequest[],
    closedPrs: PullRequest[],
    tasks: TaskSummary[],
  ): Promise<void> {
    const { store } = this.deps;
    const issueNumber = planIssueNumber(plan.originRef);
    if (issueNumber === null) return;
    const parts = store.listPlanParts(plan.id);

    // Refs are files, so a flat `issue/12` branch blocks the directory
    // `issue/12/<slug>` needs. Park the parts not yet cut and say so once.
    const flat = issueBranch(issueNumber);
    const presence = await this.deps.git.presence(flat);
    const flatTaken = presence.local || presence.remote;

    // This plan's human steps, read once per plan and *not* filtered to open ones:
    // `declined` is precisely the state this loop has to see.
    const declined = new Set(
      this.deps.store
        .listHumanTasksForParts(parts.filter(partIsHuman).map((p) => p.id))
        .filter((t) => t.status === 'declined')
        .map((t) => t.partId),
    );

    const next = new Map<string, Partial<PlanPart>>();
    for (const part of parts) {
      // A human part has no PR to fold and no agent to have stalled — settled
      // by marking its task done, stopped by declining it below.
      if (partIsHuman(part)) continue;
      // Retired: an amendment dropped it. Concluded: the store *is* the record
      // for a report/determination — folding could only undo it.
      if (part.status === 'retired' || part.status === 'concluded') continue;
      const patch = this.foldPr(part, issueNumber, prs, closedPrs) ?? this.foldStalled(part, tasks);
      if (patch) next.set(part.slug, patch);
    }
    // A working copy, so readiness below sees this pulse's observations.
    const observed = parts.map((p) => ({ ...p, ...next.get(p.slug) }) as PlanPart);
    const index = bySlug(observed);

    // A part whose branch *is* the flat one does not collide — the shape
    // `backfillWholePlanParts` leaves. A human part is never cut, so it's
    // outside the branch namespace and skipped.
    const collidesWith = (part: PlanPart): boolean =>
      flatTaken && !partIsHuman(part) && (part.branch ?? partBranch(issueNumber, part.slug)) !== flat;

    for (const part of observed) {
      if (part.status !== 'pending' && part.status !== 'ready' && part.status !== 'blocked') continue;
      // Collision first: it is the wider fact, and when git cannot cut the branch a
      // declined step is not the reason to show.
      const refused = declined.has(part.id);
      const collision = collidesWith(part);
      const status = collision || refused ? 'blocked' : await this.readiness(part, index, issueNumber);
      // The reason travels with the status. `differs` keeps writes to real transitions.
      const blockedReason = collision
        ? refCollisionReason(issueNumber, presence)
        : refused
          ? declinedStepReason(part.title)
          : null;
      // `planIsWedged` escalates a collision and must not escalate a decline;
      // re-deriving that from the prose would be one rewording from breaking.
      // → `docs/spec/08-planning.md`
      const blockedBy: PlanPartBlocker | null = collision ? 'collision' : refused ? 'declined' : null;
      if (status !== part.status || blockedReason !== part.blockedReason || blockedBy !== part.blockedBy)
        next.set(part.slug, { ...next.get(part.slug), status, blockedReason, blockedBy });
    }

    let changed = false;
    for (const part of parts) {
      const patch = next.get(part.slug);
      if (!patch || !differs(part, patch)) continue;
      store.updatePlanPart(part.id, patch);
      changed = true;
    }
    // Only on a flip: the Errors panel is a feed, and the standing reason is on the
    // part rows above.
    if (changed && observed.some(collidesWith)) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Plan for issue #${issueNumber} is blocked: ${refCollisionReason(issueNumber, presence)}`,
      });
    }

    const rolled = store.rollUpPlanStatus(plan.id);
    const current = rolled ?? plan;
    // On news only, edited in place — keeps it off the auto-send gate. Never
    // while awaiting approval: it would announce a commitment not yet made.
    if (current.status !== 'awaiting_approval' && (current.statusCommentRef === null || changed || rolled)) {
      await this.writeStatusComment(current, store.listPlanParts(plan.id), issueNumber);
    }
  }

  /**
   * What the provider says about a part's PR — see {@link observePartPr} for
   * the ordering. Inside `closedPrWindowMs` the closed list distinguishes a
   * merge from an abandonment; outside it, an absent PR falls back to
   * "merged", deliberately.
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
  private foldStalled(part: PlanPart, tasks: TaskSummary[]): Partial<PlanPart> | null {
    if (part.status !== 'dispatched') return null;
    const task = tasks.find((t) => t.id === part.taskId);
    const live = task && (task.status === 'queued' || task.status === 'running' || task.status === 'waiting');
    return live ? null : { status: 'ready' };
  }

  /**
   * `ready` once every dependency has pushed a branch worth stacking on, else
   * `pending`. This is where the dependency arity rule lives: every dependency
   * must be satisfied *and* at most one may still be unsettled, since
   * `partBase` cuts this branch from that one and two in flight give no way
   * to choose.
   */
  private async readiness(
    part: PlanPart,
    index: Map<string, PlanPart>,
    issueNumber: number,
  ): Promise<PlanPart['status']> {
    const deps = dependenciesOf(part, index);
    if (deps.length === 0) return 'ready';
    const unsettled = deps.filter((d) => !partSettled(d));
    if (unsettled.length > 1) return 'pending';
    const pushed = new Map(
      await Promise.all(
        unsettled.map(async (dep) => {
          const branch = dep.branch ?? partBranch(issueNumber, dep.slug);
          return [dep.slug, await this.deps.git.hasCommitsBeyond(branch, this.deps.defaultBranch)] as const;
        }),
      ),
    );
    const satisfied = deps.every((dep) => dependencySatisfied(dep, (d) => pushed.get(d.slug) === true));
    return satisfied ? 'ready' : 'pending';
  }

  private async writeStatusComment(plan: Plan, parts: PlanPart[], issueNumber: number): Promise<void> {
    // The validation plan rides in the same comment, so a checked-off check
    // reaches the memoisation below — otherwise the edit is never written.
    const body = renderPlanComment(
      plan,
      parts,
      this.deps.prRefStyle ?? '#',
      this.deps.store.listValidationChecks(plan.originRef),
    );
    // Second guard, after the caller's news gate. Memoised, not stored — a
    // restart costs one idempotent edit.
    if (this.lastComment.get(plan.id) === body) return;
    try {
      const result = await this.deps.sink.upsertIssueComment({
        number: issueNumber,
        body,
        commentRef: plan.statusCommentRef,
      });
      if (result.ref && result.ref !== plan.statusCommentRef) this.deps.store.setPlanStatusComment(plan.id, result.ref);
      this.lastComment.set(plan.id, body);
    } catch (err) {
      // Progress reporting must never take the pulse down with it.
      this.deps.errors?.record({
        source: 'cycle',
        message: `Could not update the plan status comment on #${issueNumber}: ${(err as Error).message}`,
      });
    }
  }
}

/**
 * Why a part a person owned is `blocked`: they were asked, and said no. A
 * declined step is never folded into a terminal — concluding it would make
 * `partSettled` true and release every dependent, completing the plan on work
 * nobody did.
 */
function declinedStepReason(title: string): string {
  return (
    `"${title}" is a step for a person, and it was declined. Nothing that depends on it can start. ` +
    `Replan the issue, or abandon the decomposition to work it whole.`
  );
}

/**
 * Why every part of a plan is `blocked`, in the harness's own words — one
 * string, so the Goal Floor plate and the Errors panel line cannot diverge.
 * Takes the {@link BranchPresence}, not a boolean, because *where* the branch
 * is decides which command works: a remote branch cannot be cleared locally,
 * since `maybeFetch`'s `git fetch --prune` restores it next pulse.
 */
export function refCollisionReason(issueNumber: number, presence: BranchPresence): string {
  const flat = issueBranch(issueNumber);
  const head =
    `The branch ${flat} exists ${presence.remote ? 'on origin' : 'locally'}, and git cannot create ` +
    `${partBranch(issueNumber, '<part>')} while it does (refs are files, not directories).`;
  if (!presence.remote) return `${head} Delete or rename the local ${flat} (\`git branch -m\`) to unblock the parts.`;
  return (
    `${head} It has to go on the remote — \`git push origin --delete ${flat}\`. Deleting it locally does ` +
    `nothing here: plan reconciliation fetches with \`--prune\` every pulse, which restores the ` +
    `remote-tracking ref straight away.`
  );
}

/** Does a patch actually move the row? Keeps reconciliation writes to real transitions. */
function differs(part: PlanPart, patch: Partial<PlanPart>): boolean {
  return (Object.keys(patch) as (keyof PlanPart)[]).some((key) => patch[key] !== part[key]);
}
