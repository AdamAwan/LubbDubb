import type { Decision, Plan } from '../types.js';
import { dispatchVerdict, type CooldownPolicy, type DispatchVerdict } from '../dispatcher/dispatchCooldown.js';

/**
 * The planning funnel: every watched, open issue passes a planning agent that
 * emits one of two verdicts — `single` (the one-agent / one-PR path) or `parts`
 * (a decomposition into stacked PRs). **Always on**: every watched issue is
 * routed by a planner, and there is no deployment in which one is not.
 */
export interface PlanningPolicy {
  /**
   * How many parts of one plan may have agents at once. A cap rather than fanning
   * the whole graph out the moment dependencies are satisfied: manual stacking
   * works because a human holds the decomposition in their head, and N concurrent
   * agents do not. Threaded now; the part scheduler consumes it.
   */
  maxConcurrentPartsPerIssue: number;
  /**
   * Put a planner's verdict to a human before anything is scheduled from it
   * (issue #109 phase 3). **On by default.** The funnel itself is not a choice —
   * every goal is planned — so the thing being defaulted is only whether a
   * planner's decision about how an issue is worked starts itself.
   *
   * On, ingestion persists the verdict as `awaiting_approval`, rule
   * `plan-approval` puts it to the operator once, and nothing is scheduled until
   * they accept — approve-before rather than replan-after, which is the undo we
   * built in place of this gate.
   *
   * **Both arms.** A `single` verdict is a verdict about shape too — the same
   * decision, differently answered — and gating only the `parts` arm left the
   * commonest route with no acceptance step in it at all. The one arm still never
   * gated is the `single` verdict the harness *overruled*, because parts are
   * already in flight: the collapse was refused, so there is no decision in it.
   */
  requireApproval: boolean;
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
  maxConcurrentPartsPerIssue: 2,
  requireApproval: true,
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
 * - `single` — fall through to normal pickup (rule `issue-pickup`). `failedOpen` marks the
 *   issue that got there because planning gave up, not because a planner said so.
 * - `parts`  — decomposed; the part scheduler owns it, pickup stays off.
 * - `awaiting_approval` — the planner has spoken, but its verdict is a proposal a
 *   human has not answered yet (`planning.requireApproval`), on either arm. Pickup
 *   stays off exactly as for `parts` — including for a *single* verdict, which is
 *   the whole point: nothing is worked before the acceptance step. The part
 *   scheduler queues a decomposition's parts without dispatching any of them.
 * - `planning` — a planner is still owed, either dispatchable now or cooling down.
 */
export type PlanRouteVerdict =
  | { route: 'single'; failedOpen: boolean }
  | { route: 'parts' }
  | { route: 'awaiting_approval' }
  | { route: 'planning'; planner: 'dispatch' | 'cooldown' };

interface PlanRouteInput {
  /** The persisted plan for this issue, or null when the planner hasn't spoken. */
  plan: Plan | null;
  /** The plan origin's cooldown verdict — {@link plannerVerdict}. */
  verdict: DispatchVerdict;
  /**
   * How many parts the plan declares (retired ones excluded). Absent = none.
   *
   * This is the plan's **shape**, and it is why the arm is not read off the status
   * alone: a plan with no live parts is the single arm, whatever else is true of
   * it. It also decides what a *failed* replan falls back to.
   */
  existingParts?: number;
}

/**
 * The plan origin's cooldown verdict, with one adjustment a replan needs: while a
 * plan row sits in `planning`, attempts made **before** the operator asked for the
 * replan are not this replan's attempts.
 *
 * Without it, "replan" on an issue the funnel already planned would be met with a
 * fifteen-minute cooldown from the original planner (or, worse, an already-spent
 * attempt cap), and the button would appear to do nothing. `planning` is only ever
 * reached by an explicit replan — ingestion writes `active`/`awaiting_approval` — so the
 * narrowed window can't loosen the throttle on a first-time planner.
 *
 * The boundary is **strict**: an attempt stamped in the same millisecond as the
 * plan write is the *previous* planner's, because the two are ordered by
 * construction — the decision is recorded by a cycle that ran before the operator
 * asked, and `/replan` moves the plan afterwards. Only a millisecond clock makes
 * them look simultaneous. Breaking that tie the other way is what the window
 * exists to prevent (the button appears to do nothing for fifteen minutes); the
 * cost the other way is at most one uncooled re-dispatch when a replan's *own*
 * planner is dispatched inside the same millisecond as the request, and the
 * origin gate already stops that being a second concurrent planner.
 */
export function plannerVerdict(
  issueNumber: number,
  plan: Plan | null,
  now: string,
  recentDecisions: Decision[],
  cooldown: CooldownPolicy,
): DispatchVerdict {
  const since = plan?.status === 'planning' ? Date.parse(plan.updatedAt) : NaN;
  const decisions = Number.isNaN(since)
    ? recentDecisions
    : recentDecisions.filter((d) => Date.parse(d.createdAt) > since);
  return dispatchVerdict(planOrigin(issueNumber), now, decisions, cooldown);
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
 *
 * A **replan** fails back differently, and must: an issue that already has parts
 * has an existing decomposition to fall back on, and `single` would point rule `issue-pickup`
 * at the flat `issue/<n>` branch that git cannot create beside the part refs. The
 * point of failing open is that the issue keeps moving — for a replan, that means
 * carrying on with the plan it already had.
 */
export function resolvePlanRoute(input: PlanRouteInput): PlanRouteVerdict {
  const plan = input.plan;
  if (plan) {
    // The shape, not a status: a plan being delivered with no live parts *is* the
    // single arm. Read this way rather than from a `single` status, because a
    // status that carried the shape made the two exclusive — a single-PR plan
    // could not also be running, so every stage that asks "is this plan live?"
    // silently answered no for it.
    if (plan.status === 'active' && (input.existingParts ?? 0) === 0) return { route: 'single', failedOpen: false };
    // Named rather than folded into `parts`: the two behave identically for
    // pickup (the issue is planned either way) and differently for everything
    // downstream, and this is the one place the arm is decided — so an
    // "awaiting your approval" issue must be answerable here rather than the
    // dispatcher and the cockpit chip each inferring it from the plan row.
    if (plan.status === 'awaiting_approval') return { route: 'awaiting_approval' };
    // A row still in `planning` is a replan in flight — a planner is owed again.
    if (plan.status !== 'planning') return { route: 'parts' };
  }
  const kind = input.verdict.kind;
  if (kind === 'escalate' || kind === 'hold') {
    return (input.existingParts ?? 0) > 0 ? { route: 'parts' } : { route: 'single', failedOpen: true };
  }
  return { route: 'planning', planner: kind === 'cooldown' ? 'cooldown' : 'dispatch' };
}
