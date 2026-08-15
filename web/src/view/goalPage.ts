import type {
  Agent,
  AppState,
  CockpitDecision,
  Issue,
  OpenPullRequest,
  Plan,
  PlanPart,
  PullRequest,
  ValidationCheck,
  ValidationResourceView,
} from '../types.js';
import type { NeedRow } from './needsYou.js';

/**
 * Where a part stands, folded from `status` alone. Four groups rather than eight
 * statuses because the page is read as a sequence — what is done, what is moving,
 * what is stuck, what has not started — and `ready` versus `pending` is a
 * distinction the queue's own reason states better than a column heading can.
 */
export type PartGroup = 'merged' | 'now' | 'held' | 'waiting';

export interface GoalPartView {
  part: PlanPart;
  group: PartGroup;
  /** The agent on this part right now, when there is one. */
  agentId: string | null;
}

/** The overview's five-segment reading of a goal. */
export interface GoalTrack {
  merged: number;
  now: number;
  held: number;
  waiting: number;
  total: number;
}

export interface GoalPageView {
  issue: Issue;
  /** This goal's open asks, already ordered by {@link buildNeedsYou}. */
  needs: NeedRow[];
  plan: Plan | null;
  parts: GoalPartView[];
  /**
   * The parts the plan no longer schedules, in the order it declared them.
   *
   * Held apart from `parts` rather than folded in as a fifth group, because every
   * count on the page and the overview's segment track are reads of `parts` and a
   * retired part is not one of the goal's: it is what the plan *proposed*. Drawn
   * all the same, because what an amendment dropped is half of what the plan's
   * record is for — a goal whose part list shrank between two readings otherwise
   * simply lost rows, with nothing saying so.
   */
  retiredParts: PlanPart[];
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: Agent[];
  /** This goal's own slice of the decision log, newest first as the server ordered it. */
  decisions: CockpitDecision[];
  /**
   * How anyone checks this goal was met, superseded checks included — drawing what
   * an amended plan withdrew is half of what the record is for.
   *
   * They reach the page directly off the goal ref rather than through `plan`,
   * because that is what a check now hangs from: a verdict is keyed on the goal,
   * not on the plan that proposed it ([20](../../../docs/spec/20-validation.md)).
   * Routing them through the plan would lose every check on a goal whose plan was
   * abandoned — the case where an operator most needs to know what was never run.
   */
  checks: ValidationCheck[];
  /** The checks' declared resources, each already resolved to a path and a present/missing fact. */
  checkResources: ValidationResourceView[];
}

/**
 * Whether `candidate` names this goal or something under it (`issue:1:part:x`),
 * not merely a ref that shares its digits as a prefix — `startsWith` alone
 * matches `issue:14` against `issue:1`, pulling another goal's agents and
 * decisions onto this page.
 */
function belongsToGoal(candidate: string | null | undefined, ref: string): boolean {
  return candidate === ref || (candidate?.startsWith(`${ref}:`) ?? false);
}

/**
 * Whether this pull request is one of the goal's.
 *
 * Three ways, and the part rows are only the first of them. A goal the funnel
 * failed open on has no parts at all and its pull request is on the flat
 * `issue/<n>` branch, so a page keyed on `prNumber` alone drew nothing for it. The
 * other two are the server's own matching, in `resolveIssuePr`: the branch
 * convention (`issue/<n>`, and `issue/<n>/<slug>` for a part whose row has not
 * caught up), and `linkedPrNumber` for a PR the provider linked itself. The convention is restated here rather than imported because the
 * cockpit names `src/wire.ts` and nothing else; it is a *string shape*, not a
 * verdict, and the pair is pinned by `test/goalPage.test.ts`.
 */
function ownsPr(pr: PullRequest, issue: Issue, partPrs: ReadonlySet<number>): boolean {
  const ref = `issue:${issue.number}`;
  return partPrs.has(pr.number) || pr.number === issue.linkedPrNumber || branchGoal(pr.branch) === ref;
}

/**
 * The goal a branch name declares, as `issue:<n>` — `issue/12` and
 * `issue/12/signer` both, and nothing else. One implementation of the convention,
 * because it is read in two directions: from a goal, to find its pull requests
 * ({@link ownsPr}); and from a pull request, to find the goal an ask raised on it
 * belongs to ({@link goalOfPr}). Two readings of one string shape is how
 * `issue/14` ends up matching `issue:1`.
 */
function branchGoal(branch: string): string | null {
  const m = /^issue\/(\d+)(?:\/|$)/.exec(branch);
  return m ? `issue:${m[1]}` : null;
}

/**
 * The goal a pull request belongs to, as `issue:<n>`, or null when no ticket owns
 * it. The same three ways {@link ownsPr} matches, read backwards — a PR row, a
 * `linkedPrNumber`, or the branch convention.
 *
 * Null is a real answer, not a lookup failure: the harness works ticketless pull
 * requests as first-class subjects ([05](../../../docs/spec/05-dispatcher.md)), so
 * an ask raised on one has no goal to be read next to, and the surface that draws
 * it must say so rather than imply a goal it cannot name.
 *
 * @public shared with buildNeedsYou, which routes a PR-origin ask by it
 */
export function goalOfPr(state: AppState, prNumber: number): string | null {
  const part = (state.planParts ?? []).find((p) => p.prNumber === prNumber);
  const plan = part ? (state.plans ?? []).find((pl) => pl.id === part.planId) : undefined;
  if (plan) return plan.originRef;

  const linked = state.world.issues.find((i) => i.linkedPrNumber === prNumber);
  if (linked) return `issue:${linked.number}`;

  const pr = [...state.world.pullRequests, ...(state.world.closedPullRequests ?? [])].find(
    (p) => p.number === prNumber,
  );
  return pr ? branchGoal(pr.branch) : null;
}

const GROUP_OF: Record<PlanPart['status'], PartGroup | null> = {
  merged: 'merged',
  concluded: 'merged',
  dispatched: 'now',
  in_review: 'now',
  blocked: 'held',
  ready: 'waiting',
  pending: 'waiting',
  retired: null,
};

/**
 * The issue a goal ref names — the world's copy, or a run the harness retained
 * after the ticket left the world. Undefined for a ref with no goal behind it.
 *
 * Exported because *whether a ref has a page* is what decides where a queue row
 * goes ({@link NeedRow.opens}), and asking that question a second way is exactly
 * how a row ends up opening a page that renders nothing.
 *
 * @public shared with buildNeedsYou's destination rule
 */
export function goalIssue(state: AppState, ref: string): Issue | undefined {
  const number = Number(/^issue:(\d+)$/.exec(ref)?.[1]);
  if (!Number.isFinite(number)) return undefined;
  return (
    state.world.issues.find((i) => i.number === number) ?? (state.retainedRuns ?? []).find((i) => i.number === number)
  );
}

/**
 * Everything one goal's page draws, assembled from the snapshot. Null for a ref
 * the world does not carry: a page of empty sections is indistinguishable from a
 * goal that exists and has nothing on it, and only one of those is worth drawing.
 *
 * `needs` is passed in rather than rebuilt so the rail and the page are one
 * reading — answering on either settles the row and the next snapshot clears both.
 */
export function buildGoalPage(state: AppState, ref: string, needs: readonly NeedRow[]): GoalPageView | null {
  const issue = goalIssue(state, ref);
  if (!issue) return null;

  const plan = (state.plans ?? []).find((p) => p.originRef === ref) ?? null;
  const parts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id)
    .flatMap<GoalPartView>((part) => {
      const group = GROUP_OF[part.status];
      if (!group) return [];
      const agent = state.agents.find(
        (a) => state.tasks.find((t) => t.id === a.taskId)?.originRef === `${ref}:part:${part.slug}`,
      );
      return [{ part, group, agentId: agent?.id ?? null }];
    })
    .sort((a, b) => a.part.seq - b.part.seq);

  const retiredParts = (state.planParts ?? [])
    .filter((p) => plan !== null && p.planId === plan.id && p.status === 'retired')
    .sort((a, b) => a.seq - b.seq);

  const partPrs = new Set(
    [...parts.map((p) => p.part), ...retiredParts].flatMap((p) => (p.prNumber === null ? [] : [p.prNumber])),
  );

  return {
    issue,
    needs: needs.filter((n) => n.goalRef === ref),
    plan,
    parts,
    retiredParts,
    openPullRequests: state.world.pullRequests.filter((pr) => ownsPr(pr, issue, partPrs)),
    closedPullRequests: (state.world.closedPullRequests ?? []).filter((pr) => ownsPr(pr, issue, partPrs)),
    agents: state.agents.filter((a) => belongsToGoal(state.tasks.find((t) => t.id === a.taskId)?.originRef, ref)),
    decisions: state.decisions.filter((d) => belongsToGoal(d.subjectRef, ref)),
    // Equality, not `belongsToGoal`: a check is keyed on the goal itself, and
    // matching descendants would pull a part's ref in as though it were one.
    checks: (state.validationChecks ?? []).filter((c) => c.originRef === ref),
    checkResources: (state.validationResources ?? []).filter((r) => r.originRef === ref),
  };
}

/**
 * The overview's track, folded off the page's own groups rather than off `status`
 * a second time — which is what stops the row and the page disagreeing about
 * whether a part is held or merely not started.
 */
export function buildGoalTrack(parts: readonly GoalPartView[]): GoalTrack {
  const count = (g: PartGroup) => parts.filter((p) => p.group === g).length;
  return {
    merged: count('merged'),
    now: count('now'),
    held: count('held'),
    waiting: count('waiting'),
    total: parts.length,
  };
}
