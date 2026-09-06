import type { Decision, Plan } from '../types.js';
import { dispatchVerdict, type CooldownPolicy, type DispatchVerdict } from '../dispatcher/dispatchCooldown.js';

// → docs/spec/08-planning.md

export interface PlanningPolicy {
  maxConcurrentPartsPerIssue: number;
  gitFetchIntervalMs: number;
}

export const DEFAULT_PLANNING: PlanningPolicy = {
  maxConcurrentPartsPerIssue: 2,
  gitFetchIntervalMs: 60_000,
};

export function planOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:plan`;
}

export function issueOrigin(issueNumber: number): string {
  return `issue:${issueNumber}`;
}

export function planOriginIssue(originRef: string | null): number | null {
  const match = /^issue:(\d+):plan$/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

export function originIssueNumber(originRef: string | null): number | null {
  const match = /^issue:(\d+)(?::|$)/.exec(originRef ?? '');
  return match ? Number(match[1]) : null;
}

export function planBranch(issueNumber: number): string {
  return `plan/issue/${issueNumber}`;
}

export type PlanRouteVerdict =
  | { route: 'parts' }
  | { route: 'awaiting_approval' }
  | { route: 'planning'; planner: 'dispatch' | 'cooldown' }
  | { route: 'unplanned' };

interface PlanRouteInput {
  plan: Plan | null;
  verdict: DispatchVerdict;
  existingParts?: number;
}

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

export function resolvePlanRoute(input: PlanRouteInput): PlanRouteVerdict {
  const plan = input.plan;
  if (plan) {
    if (plan.status === 'awaiting_approval') return { route: 'awaiting_approval' };
    if (plan.status !== 'planning') return { route: 'parts' };
  }
  const kind = input.verdict.kind;
  if (kind === 'escalate' || kind === 'hold') {
    return (input.existingParts ?? 0) > 0 ? { route: 'parts' } : { route: 'unplanned' };
  }
  return { route: 'planning', planner: kind === 'cooldown' ? 'cooldown' : 'dispatch' };
}

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
