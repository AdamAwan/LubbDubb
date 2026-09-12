import type { ErrorRecorder } from '../errorLog.js';
import type { BranchPresence, GitObserver } from '../git/gitObserver.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { Plan, PlanPart, PlanPartBlocker, PullRequest, TaskSummary, WorldSnapshot } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { renderPlanComment } from './planComment.js';
import { type PrRefStyle } from '../pr/prRef.js';
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

// → docs/spec/08-planning.md

interface PlanReconcilerDeps {
  store: Store;
  git: GitObserver;
  sink: ActionSink;
  planning: PlanningPolicy;
  defaultBranch: string;
  prRefStyle?: PrRefStyle;
  fetch?: () => Promise<void>;
  errors?: ErrorRecorder;
}

export class PlanReconciler {
  private lastFetchAt = 0;
  private lastFetchError: string | null = null;
  private readonly lastComment = new Map<string, string>();

  constructor(private readonly deps: PlanReconcilerDeps) {}

  async reconcile(world: WorldSnapshot): Promise<void> {
    const plans = this.deps.store.plans
      .listPlans()
      .filter((p) => p.status === 'active' || p.status === 'complete' || p.status === 'awaiting_approval');
    if (plans.length === 0) return;

    await this.maybeFetch();
    const tasks = this.deps.store.tasks.listTasks();
    for (const plan of plans) {
      await this.reconcilePlan(plan, world.pullRequests, world.closedPullRequests ?? [], tasks);
    }
  }

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
    const parts = store.plans.listPlanParts(plan.id);

    const flat = issueBranch(issueNumber);
    const presence = await this.deps.git.presence(flat);
    const flatTaken = presence.local || presence.remote;

    const declined = new Set(
      this.deps.store.humanTasks
        .listHumanTasksForParts(parts.filter(partIsHuman).map((p) => p.id))
        .filter((t) => t.status === 'declined')
        .map((t) => t.partId),
    );

    const next = new Map<string, Partial<PlanPart>>();
    for (const part of parts) {
      if (partIsHuman(part)) continue;
      if (part.status === 'retired' || part.status === 'concluded') continue;
      const patch = this.foldPr(part, issueNumber, prs, closedPrs) ?? this.foldStalled(part, tasks);
      if (patch) next.set(part.slug, patch);
    }
    const observed = parts.map((p) => ({ ...p, ...next.get(p.slug) }) as PlanPart);
    const index = bySlug(observed);

    const collidesWith = (part: PlanPart): boolean =>
      flatTaken && !partIsHuman(part) && (part.branch ?? partBranch(issueNumber, part.slug)) !== flat;

    for (const part of observed) {
      if (part.status !== 'pending' && part.status !== 'ready' && part.status !== 'blocked') continue;
      const refused = declined.has(part.id);
      const collision = collidesWith(part);
      const status = collision || refused ? 'blocked' : await this.readiness(part, index, issueNumber);
      const blockedReason = collision
        ? refCollisionReason(issueNumber, presence)
        : refused
          ? declinedStepReason(part.title)
          : null;
      const blockedBy: PlanPartBlocker | null = collision ? 'collision' : refused ? 'declined' : null;
      if (status !== part.status || blockedReason !== part.blockedReason || blockedBy !== part.blockedBy)
        next.set(part.slug, { ...next.get(part.slug), status, blockedReason, blockedBy });
    }

    let changed = false;
    for (const part of parts) {
      const patch = next.get(part.slug);
      if (!patch || !differs(part, patch)) continue;
      store.plans.updatePlanPart(part.id, patch);
      changed = true;
    }
    if (changed && observed.some(collidesWith)) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Plan for issue #${issueNumber} is blocked: ${refCollisionReason(issueNumber, presence)}`,
      });
    }

    const rolled = store.plans.rollUpPlanStatus(plan.id);
    const current = rolled ?? plan;
    if (current.status !== 'awaiting_approval' && (current.statusCommentRef === null || changed || rolled)) {
      await this.writeStatusComment(current, store.plans.listPlanParts(plan.id), issueNumber);
    }
  }

  private foldPr(
    part: PlanPart,
    issueNumber: number,
    prs: PullRequest[],
    closedPrs: PullRequest[],
  ): Partial<PlanPart> | null {
    return observePartPr(part, part.branch ?? partBranch(issueNumber, part.slug), prs, closedPrs);
  }

  private foldStalled(part: PlanPart, tasks: TaskSummary[]): Partial<PlanPart> | null {
    if (part.status !== 'dispatched') return null;
    const task = tasks.find((t) => t.id === part.taskId);
    const live = task && (task.status === 'queued' || task.status === 'running' || task.status === 'waiting');
    return live ? null : { status: 'ready' };
  }

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
    const body = renderPlanComment(
      plan,
      parts,
      this.deps.prRefStyle ?? '#',
      this.deps.store.validation.listValidationChecks(plan.originRef),
    );
    if (this.lastComment.get(plan.id) === body) return;
    try {
      const result = await this.deps.sink.upsertIssueComment({
        number: issueNumber,
        body,
        commentRef: plan.statusCommentRef,
      });
      if (result.ref && result.ref !== plan.statusCommentRef)
        this.deps.store.plans.setPlanStatusComment(plan.id, result.ref);
      this.lastComment.set(plan.id, body);
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `Could not update the plan status comment on #${issueNumber}: ${(err as Error).message}`,
      });
    }
  }
}

function declinedStepReason(title: string): string {
  return (
    `"${title}" is a step for a person, and it was declined. Nothing that depends on it can start. ` +
    `Replan the issue, or abandon the decomposition to work it whole.`
  );
}

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

function differs(part: PlanPart, patch: Partial<PlanPart>): boolean {
  return (Object.keys(patch) as (keyof PlanPart)[]).some((key) => patch[key] !== part[key]);
}
