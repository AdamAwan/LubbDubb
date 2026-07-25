import type { Plan } from '../types.js';
import type { DispatchVerdict } from '../dispatcher/dispatchCooldown.js';

/**
 * The planning funnel: every watched, open issue passes a planning agent that
 * emits one of two verdicts — `single` (today's one-agent / one-PR path) or
 * `parts` (a decomposition into stacked PRs). Off by default, and off leaves the
 * funnel out entirely: every issue routes straight to `single`, so rule 4 is
 * un-narrowed and behaviour is exactly what it is today.
 */
export interface PlanningPolicy {
  /** Master switch. Off by default. */
  enabled: boolean;
  /**
   * How many parts of one plan may have agents at once. A cap rather than fanning
   * the whole graph out the moment dependencies are satisfied: manual stacking
   * works because a human holds the decomposition in their head, and N concurrent
   * agents do not. Threaded now; the part scheduler consumes it.
   */
  maxConcurrentPartsPerIssue: number;
  /**
   * Minimum gap between the `git fetch`es plan reconciliation runs before reading
   * branch reality.
   *
   * The `GitObserver` is deliberately fetch-free, so without one it never sees a
   * push made anywhere but this machine — and "has the dependency actually pushed"
   * is the question a stacked part waits on. Fetching on the pulse is the simplest
   * thing that works: one round trip against the remote the provider snapshot
   * already hits, at a default 5-minute heartbeat. This floor exists only so a
   * deliberately fast heartbeat can't turn into a fetch storm; 0 = every pulse.
   */
  gitFetchIntervalMs: number;
}

export const DEFAULT_PLANNING: PlanningPolicy = {
  enabled: false,
  maxConcurrentPartsPerIssue: 2,
  gitFetchIntervalMs: 60_000,
};

/** The origin the planning agent for an issue is dispatched against. */
export function planOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:plan`;
}

/** The issue origin a plan hangs off — the `plans.origin_ref` key. */
export function issueOrigin(issueNumber: number): string {
  return `issue:${issueNumber}`;
}

/**
 * The issue number behind a planning agent's origin ref, or null when the ref is
 * not a planner's. This is what confines plan ingestion to agents the `issue-plan`
 * rule started: an ordinary pickup agent writing a `plan.json` would otherwise
 * flip its own issue to `parts` and strand it, since nothing yet schedules parts.
 */
export function planOriginIssue(originRef: string | null): number | null {
  const match = /^issue:(\d+):plan$/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The branch a planning agent works on. Deliberately a *separate namespace* from
 * both `issue/<n>` (what a `single` verdict's agent wants) and `issue/<n>/<slug>`
 * (the part branches): git stores refs as files, so `refs/heads/issue/12` and
 * `refs/heads/issue/12/plan` cannot coexist — the second needs the first to be a
 * directory. A planner branch under `issue/<n>/…` would therefore make the very
 * pickup its `single` verdict authorises impossible to branch for.
 */
export function planBranch(issueNumber: number): string {
  return `plan/issue/${issueNumber}`;
}

/**
 * Which arm of the funnel an issue is on this cycle.
 * - `single` — fall through to normal pickup (rule 4). `failedOpen` marks the
 *   issue that got there because planning gave up, not because a planner said so.
 * - `parts`  — decomposed; the part scheduler owns it, pickup stays off.
 * - `planning` — a planner is still owed, either dispatchable now or cooling down.
 */
export type PlanRouteVerdict =
  | { route: 'single'; failedOpen: boolean }
  | { route: 'parts' }
  | { route: 'planning'; planner: 'dispatch' | 'cooldown' };

export interface PlanRouteInput {
  planning: PlanningPolicy;
  /** The persisted plan for this issue, or null when the planner hasn't spoken. */
  plan: Plan | null;
  /** The plan origin's cooldown verdict — `dispatchVerdict(planOrigin(n), …)`. */
  verdict: DispatchVerdict;
}

/**
 * Resolve one issue's funnel arm. Pure over the plan row + the plan origin's
 * cooldown verdict, so the dispatcher and the cockpit's per-issue chip read the
 * same answer rather than each guessing at it.
 *
 * **Fail-open is the load-bearing part.** Narrowing pickup to `single` turns any
 * planner that crashes or writes no `plan.json` into a permanently parked issue —
 * so once the existing attempt cap is spent the issue falls open to `single` and
 * gets worked the way it does today. Nothing escalates: the cap is the signal, and
 * an issue that quietly keeps moving beats one that quietly stops.
 */
export function resolvePlanRoute(input: PlanRouteInput): PlanRouteVerdict {
  if (!input.planning.enabled) return { route: 'single', failedOpen: false };
  const plan = input.plan;
  if (plan) {
    if (plan.status === 'single') return { route: 'single', failedOpen: false };
    // A row still in `planning` is a replan in flight — a planner is owed again.
    if (plan.status !== 'planning') return { route: 'parts' };
  }
  const kind = input.verdict.kind;
  if (kind === 'escalate' || kind === 'hold') return { route: 'single', failedOpen: true };
  return { route: 'planning', planner: kind === 'cooldown' ? 'cooldown' : 'dispatch' };
}
