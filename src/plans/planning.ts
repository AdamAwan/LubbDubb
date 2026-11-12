import type { Decision, Plan } from '../types.js';
import { dispatchVerdict, type CooldownPolicy, type DispatchVerdict } from '../dispatcher/dispatchCooldown.js';
import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { UNTIL_EXPLAINED } from '../validation/watchQueryShape.js';
import { measuresOnly, watchSourceDeclarations } from '../environments/watchSource.js';

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
  return issueOriginRef('plan', issueNumber);
}

export function issueOrigin(issueNumber: number): string {
  return issueOriginRef('root', issueNumber);
}

export function planOriginIssue(originRef: string | null): number | null {
  return issueOriginNumber('plan', originRef);
}

export function planBranch(issueNumber: number): string {
  return `plan/issue/${issueNumber}`;
}

export type PlanRouteVerdict =
  | { route: 'parts' }
  | { route: 'awaiting_approval' }
  | { route: 'planning'; planner: 'dispatch' | 'cooldown' }
  | { route: 'escalated'; raise: { attempts: number } | null };

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
    if ((input.existingParts ?? 0) > 0) return { route: 'parts' };
    return {
      route: 'escalated',
      raise: input.verdict.kind === 'escalate' ? { attempts: input.verdict.attempts } : null,
    };
  }
  return { route: 'planning', planner: kind === 'cooldown' ? 'cooldown' : 'dispatch' };
}

interface WatchedEnvironment {
  name: string;
  watch?: { schema?: string; exposure?: object } & Parameters<typeof watchSourceDeclarations>[0];
}

function watchedSchemaLines(watched: readonly WatchedEnvironment[]): string[] {
  const lines: string[] = [];
  for (const env of watched) {
    const schema = env.watch?.schema?.trim();
    if (schema !== undefined && schema !== '') lines.push('', `**${env.name}** — ${schema}`);
  }
  return lines;
}

/**
 * Each watched environment's own schema prose, and — where it rolls out in stages — the rule that every
 * query is scoped to traffic running the change. → docs/spec/29-post-deploy-watch.md#exposure
 */
function watchedEnvironmentLines(watched: readonly WatchedEnvironment[]): string[] {
  const lines = [...watchSourceLines(watched), ...watchedSchemaLines(watched)];
  const staged = watched.filter((env) => env.watch?.exposure !== undefined).map((env) => env.name);
  if (staged.length > 0)
    lines.push(
      '',
      `**Staged rollout on ${staged.join(', ')}.** There a deploy is not an exposure: tenants move onto a new build ` +
        'one at a time, so most of the traffic a window first sees still runs the build before this change. Scope ' +
        'every query — signal, measure and presence alike — to traffic on a build carrying this change, the way the ' +
        "environment's notes above say to (the goal's landed commits reach the environment's command as " +
        '`LUBBDUBB_WATCH_COMMITS`). An unscoped signal reads the defect the change fixed on tenants that have not ' +
        'upgraded, and an unscoped presence query proves the code path runs somewhere other than where the change ' +
        'is. The harness holds every reading at unknown until enough of the environment runs the change, but it ' +
        'cannot scope a query for you.',
    );
  return lines;
}

export function watchHintRequired(environments: readonly WatchedEnvironment[]): boolean {
  return environments.some((env) => env.watch !== undefined);
}

/**
 * Each watched environment's sources, with their language and who runs them, and what each costs.
 * → docs/spec/29-post-deploy-watch.md#what-a-language-changes
 */
function watchSourceLines(watched: readonly WatchedEnvironment[]): string[] {
  const listed = watched.map((env) => {
    const sources = watchSourceDeclarations(env.watch).map(
      (s) => `\`${s.name}\` (${s.language}, run by ${s.runBy === 'harness' ? 'the harness' : 'the operator'})`,
    );
    return `- **${env.name}**: ${sources.join(', ')}`;
  });
  const languages = new Set(watched.flatMap((env) => watchSourceDeclarations(env.watch).map((s) => s.language)));
  const metricOnly = [...languages].filter(measuresOnly);
  return [
    '',
    '**Where each query is asked.** Each environment answers from named sources, and a check names the one it ' +
      "reads with `source`. A check that names none reads the environment's only source, so where an " +
      'environment declares more than one, name it — otherwise that environment reads the check as unknown. An ' +
      'environment without the source a check names reads it as unknown there, and that is not a refusal.',
    '',
    ...listed,
    '',
    'A source **run by the harness costs nothing**: it is asked on a schedule for as long as the window is open. ' +
      "A source **run by the operator costs a person's time**, and is for a question no other telemetry can " +
      'answer — never for convenience.',
    ...(metricOnly.length === 0
      ? []
      : [
          '',
          `A ${metricOnly.join(' or ')} source takes **measures only**: the harness cannot read whether such a ` +
            'query aggregates, so a signal there is read as unknown. Write the count as a measure with an `under`.',
        ]),
  ];
}

export function watchNote(environments: readonly WatchedEnvironment[]): string {
  if (!watchHintRequired(environments)) return '';
  const watched = environments.filter((env) => env.watch !== undefined);
  const lines = [
    '',
    '',
    '## How we will know it worked',
    '',
    'Beside `validation` — which asks whether the goal was met — the plan document takes a `watchHint`, which ' +
      'says what a running system would show, once this is deployed, if the work did what it claimed. It is ' +
      '**required** here, and it is words, not queries: the checks that read telemetry are written after the ' +
      'work is delivered, against the code that actually shipped, by whoever assesses it. Do not write a ' +
      '`watch` block.',
    '',
    'Give it one of two shapes:',
    '',
    '- `{"intents": [{"kind": "signal", "source": "logs", "says": "The statement job stops timing out", ' +
      '"why": "~37 timeouts a day today; the ticket is about exactly these"}]}` — one intent per thing worth ' +
      'watching. A **signal** is something that should stop happening, or never start: an exception, a ' +
      'failure, a retry, a log line only written when something has gone wrong. A **measure** is one number ' +
      'that should get better, or no worse: a duration, a percentile, a rate. `source` is where you would ' +
      "expect to read it — your best guess at the environment's telemetry, binding nothing. `says` is the " +
      'outcome in a plain sentence; `why` is optional.',
    '- `{"none": "Docs-only change: nothing running behaves differently"}` — nothing running changes, so ' +
      'there is nothing to watch. **The reason is required.** A refactor, a docs change or a build fix is a ' +
      'perfectly good `none`; a check forced onto one could only ever read clean, which is worse than none.',
    '',
    '**For a defect the intent is knowable now, before the fix is.** The bug report *is* the signal — a ' +
      'ticket reading "job X keeps timing out in proc Y" contains its own intent: job X stops timing out.',
    '',
    'The operator ticks this before they approve the plan: it is what they agree "worked" will mean, so ' +
      'write it for them to read.',
    '',
    `Environments whose telemetry can be asked: ${watched.map((env) => env.name).join(', ')}.`,
  ];
  return [...lines, ...watchSourceLines(watched), ...watchedSchemaLines(watched)].join('\n');
}

/**
 * What a watch author — the assessor on `delivered`, or rule `watch-plan`'s catch-up — must know about
 * this deployment's telemetry to write a query that resolves. Empty where no environment declares a
 * `watch`, which is also the gate both read. → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
 */
export function watchPlanNote(environments: readonly WatchedEnvironment[]): string {
  const watched = environments.filter((env) => env.watch !== undefined);
  if (watched.length === 0) return '';
  const lines = [
    '',
    '## Writing a check',
    '',
    'Two kinds. A **signal** returns one row per occurrence of something that should not be happening, and ' +
      'the harness counts the rows against `tolerate` — do not aggregate the query: `| count` answers one ' +
      'row whatever the number is, and is refused. It needs a `presence` query ' +
      'beside it whose only job is to prove the code path runs at all — without one, a query naming an ' +
      'operation that does not exist answers zero rows, which looks exactly like a healthy release; a ' +
      'presence query must not aggregate either, since a count can never answer zero. A ' +
      '**measure** asks for one number and declares either a threshold or `noWorseThan: "baseline"`, which ' +
      'is the right shape for an optimisation: the same query is run over the period before the merge as ' +
      'you record it, and that reading is what the work has to beat.',
    '',
    'Every query carries `{since}` — `| where timestamp > datetime({since})`, with your own timestamp ' +
      'column — which the harness replaces with the moment the work arrived on that environment. Without it ' +
      'the query answers about the whole retention period and counts the occurrences the fix was for, ' +
      'reporting a regression on the strength of the defect it fixed. It is refused without one.',
    '',
    UNTIL_EXPLAINED,
    '',
    'Write against what the merged code actually emits: the message template, the operation name, the ' +
      'property. The pull request descriptions say where an agent added a log line, a metric or an exception ' +
      'that says whether this is behaving. A timeout fixed by adding a retry does not stop producing ' +
      'timeouts — the honest signal becomes "the job fails after retries".',
    '',
    `Environments whose telemetry can be asked: ${watched.map((env) => env.name).join(', ')}.`,
  ];
  return [...lines, ...watchedEnvironmentLines(watched)].join('\n');
}

/**
 * The one sentence the working agents keep about the watch, appended to `plan-part` and the pull-request
 * fix prompts and never interpolated. Empty where no environment declares a `watch`.
 * → docs/spec/29-post-deploy-watch.md#while-the-work-happens-nothing-is-asked
 */
export function instrumentationNote(environments: readonly WatchedEnvironment[]): string {
  if (!watchHintRequired(environments)) return '';
  return (
    '\n\nIf you added a log line, a metric or an exception that says whether this is behaving, say so in the ' +
    'pull request description.'
  );
}

/**
 * The planner describes the coverage **in words**, and nothing is checked against a listing. It is
 * writing about code that does not exist yet, so a string picked from what the deployed runner offers
 * today is a guess made at the worst possible moment — and one the harness then refused at submission,
 * which is how a genuinely new area came to be undeclarable. The validation planner picks the
 * instrument later, with the diff in front of it.
 */
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
      '`coverage` field naming the **area** it adds or amends, described in words rather than as a ' +
      'file path (`checkout with a saved card`, not `tests/checkout.spec.ts`). Amending an existing spec is the ' +
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
    '- **A check about how something *looks* is not an area.** A legibility check at a particular ' +
      'width, a single component’s rendering, a spacing or truncation judgement: there is no journey ' +
      'to select and no area that could honestly claim it, so the honest answer is no test part — it ' +
      'belongs to the snapshot suite, or to a validation check whose `screenshot` step the fleet ' +
      'captures and a person judges. Picking the nearest area for one of these produces a green row ' +
      'that verified something the check does not talk about, which is worse than the row it replaced.',
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

/**
 * Why a plan-time prompt needs telling that a screen is not automatically a person's: the templates
 * are written once, for every deployment, so they name a person's eyes as the thing only running the
 * finished work answers — which is true where nothing drives a browser and wrong here. The planner
 * that reads it writes *somebody will have to look at this by hand* into a hint that is then read by
 * the check author as the intent an operator approved, and a deployment that captures screens for a
 * living fills its bench with trips the fleet could have made, with nothing red.
 *
 * It says nothing about **who** carries the step, which is not the plan's to say and is read off the
 * configuration at authoring time (`validationPlanNote`, and
 * [20](../../docs/spec/20-validation.md#who-carries-a-step)). What it asks for is a hint that names
 * the screen and what would be wrong with it, and leaves the assignment out.
 */
export function screenCheckNote(
  environments: readonly { name: string; validate?: { browser?: { runner?: string } } }[],
): string {
  if (!environments.some((env) => env.validate?.browser !== undefined)) return '';
  return [
    '',
    '',
    '## Somebody looking at a screen',
    '',
    'This deployment’s fleet drives a browser. So **“somebody should look at this” is not by itself a ' +
      'person’s job here**: a validation check can carry a `screenshot` step, and the fleet navigates to ' +
      'the screen and captures it. What stays a person’s is the **judgement** on what came back — ' +
      'whether the spacing is wrong, whether that copy reads right — and never the going and looking.',
    '',
    '- **In the `validation` hint, name the screen and what would be wrong with it, not who looks.** ' +
      '“Worth looking at the batch page after an import: the row count beside each batch, and what the ' +
      'page shows while one is still running” is a hint that can be carried. “Somebody will have to ' +
      'check this by hand” nominates a person for a trip the fleet can make, and it is not yours to ' +
      'nominate — who carries a step is read off what each environment declares, by the agent that ' +
      'writes the checks against the code that shipped.',
    '- **`expectedKind: "human"` is for what no agent can reach at all** — a console nobody gave the ' +
      'fleet an account for, something physically plugged in, a decision that is somebody else’s to ' +
      'make. A rendered screen is not one of those. A `human` part is never dispatched and everything ' +
      'naming it waits on a person’s day, so reaching for it to get a screen looked at stalls the plan ' +
      'for a reason that is not true.',
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
