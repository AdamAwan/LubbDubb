import type { Decision, Plan } from '../types.js';
import { dispatchVerdict, type CooldownPolicy, type DispatchVerdict } from '../dispatcher/dispatchCooldown.js';

/**
 * The planning funnel: every watched, open issue passes a planning agent, which
 * writes a plan — one or more parts, each its own branch and pull request.
 * **Always on**: every watched issue is planned, and there is no deployment in
 * which one is not.
 *
 * There is no second shape. A plan that is one pull request is a plan with one
 * part, scheduled by rule `plan-part` on `issue/<n>/<slug>` exactly as a plan with
 * eight parts is. That used to be a whole separate arm — a `single` verdict
 * carrying *zero* parts, worked by rule `issue-pickup` on the flat `issue/<n>`
 * branch — and every consumer downstream had to know which arm it was looking at.
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
   * On, ingestion persists the plan as `awaiting_approval`, rule `plan-approval`
   * puts it to the operator once, and nothing is scheduled until they accept —
   * approve-before rather than replan-after, which is the undo we built in place
   * of this gate.
   *
   * **Every plan, whatever its size.** A one-part plan is put to the operator on
   * exactly the terms an eight-part one is: it is the same decision about the same
   * thing — whether this work, as described, should happen — and the part count is
   * not what makes it worth asking about.
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
 * The issue behind *any* origin in the `issue:<n>` subtree — the pickup root, a
 * part, a planner, an assay, an assessment — or null for a ref naming something
 * else entirely.
 *
 * Deliberately not {@link planOriginIssue}, which answers a narrower question and
 * is named after it. A reader that wants the plan an origin belongs to needs this
 * one: a part origin is the only shape that needs the plan and the only shape
 * `planOriginIssue` refuses, so reaching for it there resolves every part agent's
 * plan to null and refuses it work it was dispatched to do.
 */
export function originIssueNumber(originRef: string | null): number | null {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The branch a planning agent works on. Deliberately a *separate namespace* from
 * both `issue/<n>` (what an unplanned pickup works on when the funnel fails open)
 * and `issue/<n>/<slug>` (the part branches): git stores refs as files, so
 * `refs/heads/issue/12` and `refs/heads/issue/12/plan` cannot coexist — the second
 * needs the first to be a directory. A planner branch under `issue/<n>/…` would
 * therefore collide with the parts of the very plan it is writing.
 */
export function planBranch(issueNumber: number): string {
  return `plan/issue/${issueNumber}`;
}

/**
 * Which arm of the funnel an issue is on this cycle.
 * - `parts`  — planned; the part scheduler owns it, whether the plan has one part
 *   or eight. Pickup stays off.
 * - `awaiting_approval` — the plan is written, but it is a proposal a human has
 *   not answered yet (`planning.requireApproval`). Pickup stays off exactly as for
 *   `parts`, and the part scheduler queues the parts without dispatching any.
 * - `planning` — a planner is still owed, either dispatchable now or cooling down.
 * - `unplanned` — **the fail-open arm, and the only thing rule `issue-pickup` now
 *   works.** There is no plan and there is not going to be one: the planner spent
 *   its attempt cap or is being held off, so the issue falls through to being
 *   worked whole on the flat `issue/<n>` branch rather than parked for ever.
 *
 * `unplanned` replaced a `single` route that meant two different things at once —
 * "a planner decided one PR is right" and "no planner ever answered" — reached by
 * the same arm and told apart by a `failedOpen` flag every reader had to remember
 * to check. The first of those is now an ordinary one-part plan, so what is left
 * here is only the failure, and it is named after it.
 */
export type PlanRouteVerdict =
  | { route: 'parts' }
  | { route: 'awaiting_approval' }
  | { route: 'planning'; planner: 'dispatch' | 'cooldown' }
  | { route: 'unplanned' };

interface PlanRouteInput {
  /** The persisted plan for this issue, or null when the planner hasn't spoken. */
  plan: Plan | null;
  /** The plan origin's cooldown verdict — {@link plannerVerdict}. */
  verdict: DispatchVerdict;
  /**
   * How many parts the plan declares (retired ones excluded). Absent = none.
   *
   * Read for one question only: what a *failed replan* falls back to. An issue
   * that already has parts has a plan to carry on with, so a planner that cannot
   * settle must not drop it back to unplanned pickup.
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
 * **Fail-open is the load-bearing part.** Narrowing pickup to nothing turns any
 * planner that crashes or writes no `plan.json` into a permanently parked issue —
 * so once the existing attempt cap is spent the issue falls open to `unplanned`
 * and gets worked whole. Nothing escalates: the cap is the signal, and an issue
 * that quietly keeps moving beats one that quietly stops.
 *
 * A **replan** fails back differently, and must: an issue that already has parts
 * has a plan to fall back on, and `unplanned` would point rule `issue-pickup` at
 * the flat `issue/<n>` branch that git cannot create beside the part refs. The
 * point of failing open is that the issue keeps moving — for a replan, that means
 * carrying on with the plan it already had.
 *
 * **A plan's part count is not asked about here.** It used to be the first
 * question — no live parts meant the single arm, whatever else was true — and that
 * one line was what made a one-part plan a different kind of thing from a two-part
 * one all the way down.
 */
export function resolvePlanRoute(input: PlanRouteInput): PlanRouteVerdict {
  const plan = input.plan;
  if (plan) {
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
    return (input.existingParts ?? 0) > 0 ? { route: 'parts' } : { route: 'unplanned' };
  }
  return { route: 'planning', planner: kind === 'cooldown' ? 'cooldown' : 'dispatch' };
}
