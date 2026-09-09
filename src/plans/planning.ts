import type { Decision, Plan } from '../types.js';
import { dispatchVerdict, type CooldownPolicy, type DispatchVerdict } from '../dispatcher/dispatchCooldown.js';

// → docs/spec/08-planning.md

export interface PlanningPolicy {
  maxConcurrentPartsPerIssue: number;
  gitFetchIntervalMs: number;
  fileBudget: number;
}

export const DEFAULT_PLANNING: PlanningPolicy = {
  maxConcurrentPartsPerIssue: 2,
  gitFetchIntervalMs: 60_000,
  fileBudget: 20,
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
    'A signal query returns **one row per occurrence** and the harness counts the rows against `tolerate` — ' +
      'so do not aggregate it. `| count` or a bare `| summarize` answers one row whatever the number is, ' +
      'which reads as exactly one occurrence on every reading for ever; both queries are refused at ' +
      'submission. Return the matching rows and let `tolerate` say how many are allowed.',
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
    'Two kinds. A **signal** returns one row per occurrence of something that should not be happening, and ' +
      'the harness counts the rows against `tolerate` — do not aggregate the query: `| count` answers one ' +
      'row whatever the number is, and is refused. It needs a `presence` query ' +
      'beside it whose only job is to prove the code path runs at all — without one, a query naming an ' +
      'operation that does not exist answers zero rows, which looks exactly like a healthy release; a ' +
      'presence query must not aggregate either, since a count can never answer zero. A ' +
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

export function testPartNote(
  environments: readonly { name: string; validate?: { browser?: { runner?: string } } }[],
): string {
  if (!environments.some((env) => env.validate?.browser !== undefined)) return '';
  return [
    '',
    '',
    '## Coverage this change needs, or invalidates',
    '',
    'This deployment has an end-to-end browser suite. Where the goal needs coverage the suite does not ' +
      'have — **or invalidates coverage it already has** — declare a part for it and give that part a ' +
      '`coverage` field naming the **area** it adds or amends, in words rather than as a file path ' +
      '(`checkout with a saved card`, not `tests/checkout.spec.ts`). Amending an existing spec is the ' +
      'normal case rather than a conflict: a change that changes behaviour is supposed to change the ' +
      'statement of that behaviour, in the same change, reviewed by the same reviewer.',
    '',
    'It is an ordinary part in every other respect. It produces code, it is judged on its own ' +
      '`acceptance`, it merges, and **it holds the goal exactly as any other part does** — there is no ' +
      'soft hold and no delivered-except-for-the-test. So the declaration is the decision, and the bar ' +
      'is strict:',
    '',
    '- **Automate only where the failure would be silent and consequential** — usually a common path a ' +
      'person would not notice breaking until somebody else did. **Most goals get none.** A refactor ' +
      'whose whole claim is that behaviour did not change declares no test part; so does a copy change, ' +
      'a config change and most bug fixes. **Nothing counts test parts and nothing rewards a longer ' +
      'list.**',
    '- **The critical path is an allow-list, never a deny-list.** The deployment pipeline selects only ' +
      'what carries the critical tag, so a new spec is invisible to it until somebody deliberately tags ' +
      'it. Promoting one into the critical path is a separate, reviewed pull request with an argument ' +
      'attached — never a line in this plan.',
    '- **A spec copied from a neighbour inherits that neighbour’s tags**, and a critical tag riding ' +
      'along that way is noticed only when the pipeline is two minutes slower. Say in the part’s ' +
      '`acceptance` that any inherited tags are stripped.',
    '',
    'Declaring at most one is the usual shape. Declaring none is a complete answer.',
  ].join('\n');
}

export function stateDeclareNote(
  environments: readonly { name: string; validate?: { state?: { run: string } } }[],
): string {
  const stores = environments.filter((env) => (env.validate?.state?.run ?? '').trim() !== '');
  if (stores.length === 0) return '';
  return [
    '',
    '',
    '## The data it writes',
    '',
    'If your change writes data — a new column, a new row, a status, a flag, a record — declare the query ' +
      'that says whether it is shaped correctly with the `state_declare` tool before you conclude. You are ' +
      'the only party who knows which table took it and what a correct row looks like: a planner reading ' +
      'the repository as it stood *before* the work could not have known, and nothing downstream can ' +
      'recover it.',
    '',
    'It returns the matching **rows themselves** and the harness counts them — do not aggregate: `| count` ' +
      'answers one row whatever the number is, and is refused. It needs a `presence` query beside it whose ' +
      'only job is to prove the store holds the thing at all, because a query naming a column that is not ' +
      'there answers zero rows, which looks exactly like a healthy release; a presence query must not ' +
      'aggregate either, since a count can never answer zero. Every query must be **read-only** — nothing ' +
      'here may write to a deployed environment.',
    '',
    'It merges on the id, so naming one query leaves the rest alone, and it withdraws nothing. Nothing you ' +
      'declare runs on a sheet until an operator has read the query and accepted it against one named ' +
      'environment: it goes to their store with their credential, and consent to a place is not ' +
      'transferable. Declaring nothing is a legitimate answer — a refactor, a docs change or a build fix ' +
      'writes no data to ask about.',
    '',
    `Environments whose store can be asked: ${stores.map((env) => env.name).join(', ')}.`,
  ].join('\n');
}
