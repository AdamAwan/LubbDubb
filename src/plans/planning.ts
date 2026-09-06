import type { Decision, Plan } from '../types.js';
import { dispatchVerdict, type CooldownPolicy, type DispatchVerdict } from '../dispatcher/dispatchCooldown.js';

/**
 * The planning funnel: every watched, open issue passes a planning agent, which writes a plan —
 * one or more parts, each its own branch and pull request. **Always on**, and always approved: a
 * plan lands as `awaiting_approval` and nothing is scheduled until the operator accepts. There is
 * no second shape — a one-pull-request plan is a plan with one part, scheduled like an eight-part one.
 */
export interface PlanningPolicy {
  /** How many parts of one plan may have agents at once — a cap rather than fanning the whole graph out at once. */
  maxConcurrentPartsPerIssue: number;
  /** Minimum gap between the `git fetch`es plan reconciliation runs, since `GitObserver` is fetch-free. A floor against fetch storms only; 0 = every pulse. */
  gitFetchIntervalMs: number;
}

export const DEFAULT_PLANNING: PlanningPolicy = {
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

/** The issue number behind a planning agent's origin ref, or null. Confines plan ingestion to agents the `issue-plan` rule started — an ordinary pickup agent writing `plan.json` would otherwise flip its own issue to `parts` and strand it. */
export function planOriginIssue(originRef: string | null): number | null {
  const match = /^issue:(\d+):plan$/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

/** The issue behind *any* origin in the `issue:<n>` subtree, or null. Use this rather than {@link planOriginIssue} to find the plan an origin belongs to — that one refuses part origins. */
export function originIssueNumber(originRef: string | null): number | null {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

/** The branch a planning agent works on — a *separate namespace* from `issue/<n>` and `issue/<n>/<slug>`, since git stores refs as files and a nested branch would collide with the plan's own parts. */
export function planBranch(issueNumber: number): string {
  return `plan/issue/${issueNumber}`;
}

/**
 * Which arm of the funnel an issue is on this cycle.
 * - `parts` — planned; the part scheduler owns it, one part or eight. Pickup stays off.
 * - `awaiting_approval` — plan written, unanswered proposal. Pickup stays off; parts queue without dispatching.
 * - `planning` — a planner is still owed, dispatchable now or cooling down.
 * - `unplanned` — **the fail-open arm, and the only thing rule `issue-pickup` now works.** The
 *   planner spent its attempt cap or is held off, so the issue is worked whole on the flat
 *   `issue/<n>` branch rather than parked forever.
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
  /** How many parts the plan declares (retired excluded). Absent = none. Used only so a *failed replan* on an issue with existing parts doesn't drop back to unplanned pickup. */
  existingParts?: number;
}

/**
 * The plan origin's cooldown verdict, with one adjustment: while a plan row sits in `planning`,
 * attempts made **before** the operator asked for the replan are not this replan's attempts —
 * otherwise the replan button appears to do nothing. The boundary is **strict**: an attempt
 * stamped in the same millisecond as the plan write is the previous planner's.
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
 * Resolve one issue's funnel arm. Pure over the plan row + cooldown verdict, so the dispatcher and
 * the cockpit's chip agree. **Fail-open is load-bearing**: once the attempt cap is spent the issue
 * falls open to `unplanned` and is worked whole rather than parked forever. A **replan** fails back
 * to `parts` instead, since git cannot create the flat `issue/<n>` branch beside existing part refs.
 */
export function resolvePlanRoute(input: PlanRouteInput): PlanRouteVerdict {
  const plan = input.plan;
  if (plan) {
    // Named rather than folded into `parts`: identical for pickup, different downstream.
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

/**
 * What a planner is told about the post-deploy watch, **appended** to whichever prompt it got and
 * never interpolated — an override that never learned a `{watch}` token would drop it silently.
 * Empty where no environment declares telemetry (the off switch). Structurally typed so
 * `src/dispatcher/` need not import `src/environments/`. → `docs/spec/09-execution.md`
 */
export function watchNote(environments: readonly { name: string; watch?: { schema?: string } }[]): string {
  const watched = environments.filter((env) => env.watch !== undefined);
  if (watched.length === 0) return '';
  const lines = [
    '',
    '',
    '## After it ships',
    '',
    'Beside `validation` — which asks whether the goal was met — the plan document takes a `watch` block, ' +
      'which asks whether the thing is behaving once it is deployed. Declare a `signal` for anything that ' +
      'should stop happening, or should never start: an exception, a failure, a retry, a log line only ' +
      'written when something has gone wrong.',
    '',
    '**For a defect this is knowable now, before the fix is.** The bug report *is* the signal — a ticket ' +
      'reading "job X keeps timing out in proc Y" contains its own post-deploy check, and that check can be ' +
      'written, and proven to fire, before a line of the fix exists.',
    '',
    'Every signal needs a `presence` query: a second query whose only job is to prove the code path runs at ' +
      'all. A query naming an operation that does not exist answers zero rows, zero rows looks exactly like a ' +
      'healthy release, and that is the direction that reads as success — so without one the harness would ' +
      'report your fix verified on the strength of a typo.',
    '',
    'Both queries are run once against the environment the moment you submit, and you are told what each ' +
      'answered. A query that resolves nothing comes back to you here, where it is cheap.',
    '',
    'Declaring nothing is a legitimate answer. A refactor, a docs change or a build fix has nothing running ' +
      'to watch, and an empty watch is not the same claim as a clean one.',
    '',
    `Environments whose telemetry can be asked: ${watched.map((env) => env.name).join(', ')}.`,
  ];
  for (const env of watched) {
    const schema = env.watch?.schema?.trim();
    if (schema !== undefined && schema !== '') lines.push('', `**${env.name}** — ${schema}`);
  }
  return lines.join('\n');
}

/**
 * What a **working** agent is told about the post-deploy watch — appended, never interpolated.
 * Separate from {@link watchNote}: a working agent declares what the code it just wrote emits, as
 * a proposal the operator rules on. Empty where no environment declares telemetry.
 */
export function watchDeclareNote(environments: readonly { name: string; watch?: { schema?: string } }[]): string {
  const watched = environments.filter((env) => env.watch !== undefined);
  if (watched.length === 0) return '';
  const lines = [
    '',
    '',
    '## After it ships',
    '',
    'If you added a log line, an exception, a metric or a counter that says whether this is behaving, ' +
      'declare the watch that reads it with the `watch_declare` tool before you conclude. You are the only ' +
      'party that knows the message template, the operation name and the property you wrote — a planner ' +
      'could not have guessed them, and nothing downstream can recover them.',
    '',
    'Two kinds. A **signal** counts something that should not be happening, and needs a `presence` query ' +
      'beside it whose only job is to prove the code path runs at all — without one, a query naming an ' +
      'operation that does not exist answers zero rows, which looks exactly like a healthy release. A ' +
      '**measure** asks for one number and declares either a threshold or `noWorseThan: "baseline"`, which ' +
      'is the right shape for an optimisation: the same query is run the moment the operator accepts it, ' +
      'and that reading is what your work has to beat.',
    '',
    'Use it too where the fix changed what the right question is. A timeout fixed by adding a retry does ' +
      'not stop producing timeouts — the honest signal becomes "the job fails after retries", and only you ' +
      "are holding the diff that says so. It merges on the check's id, so naming one leaves the rest alone.",
    '',
    'Nothing you declare runs until the operator accepts it: the query goes to their telemetry with their ' +
      'credential, so it lands on the plan sheet as a pending change. Declaring nothing is a legitimate ' +
      'answer — a refactor or a docs change has nothing running to watch.',
    '',
    `Environments whose telemetry can be asked: ${watched.map((env) => env.name).join(', ')}.`,
  ];
  for (const env of watched) {
    const schema = env.watch?.schema?.trim();
    if (schema !== undefined && schema !== '') lines.push('', `**${env.name}** — ${schema}`);
  }
  return lines.join('\n');
}
