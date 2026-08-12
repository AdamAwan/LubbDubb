import type {
  Agent,
  AppState,
  CockpitDecision,
  Issue,
  OpenPullRequest,
  Plan,
  PlanPart,
  PullRequest,
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
  openPullRequests: OpenPullRequest[];
  closedPullRequests: PullRequest[];
  agents: Agent[];
  /** This goal's own slice of the decision log, newest first as the server ordered it. */
  decisions: CockpitDecision[];
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
 * Everything one goal's page draws, assembled from the snapshot. Null for a ref
 * the world does not carry: a page of empty sections is indistinguishable from a
 * goal that exists and has nothing on it, and only one of those is worth drawing.
 *
 * `needs` is passed in rather than rebuilt so the rail and the page are one
 * reading — answering on either settles the row and the next snapshot clears both.
 */
export function buildGoalPage(state: AppState, ref: string, needs: readonly NeedRow[]): GoalPageView | null {
  const number = Number(/^issue:(\d+)$/.exec(ref)?.[1]);
  if (!Number.isFinite(number)) return null;

  const issue =
    state.world.issues.find((i) => i.number === number) ?? (state.retainedRuns ?? []).find((i) => i.number === number);
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

  const partPrs = new Set(parts.flatMap((p) => (p.part.prNumber === null ? [] : [p.part.prNumber])));

  return {
    issue,
    needs: needs.filter((n) => n.goalRef === ref),
    plan,
    parts,
    openPullRequests: state.world.pullRequests.filter((pr) => partPrs.has(pr.number)),
    closedPullRequests: (state.world.closedPullRequests ?? []).filter((pr) => partPrs.has(pr.number)),
    agents: state.agents.filter((a) => belongsToGoal(state.tasks.find((t) => t.id === a.taskId)?.originRef, ref)),
    decisions: state.decisions.filter((d) => belongsToGoal(d.subjectRef, ref)),
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
