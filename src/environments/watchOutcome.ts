import type {
  GoalWatch,
  WatchCheckVerdict,
  WatchOutcome,
  WatchOutcomeCheck,
  WatchHint,
  WatchReading,
  WatchWindow,
} from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import { declaredSource } from './watchSource.js';
import { withPeriod } from '../validation/watchQueryShape.js';

// → docs/spec/29-post-deploy-watch.md#the-outcome

const HOUR_MS = 60 * 60 * 1000;

/** Why the watch measures nothing, as the plan's hint stated it; null where it named something to watch. */
export function hintEmptyReason(hint: WatchHint | null | undefined): string | null {
  return hint !== null && hint !== undefined && 'none' in hint ? hint.none : null;
}

export function watchOutcome(input: {
  goalRef: string;
  /** The goal's live checks. */
  checks: readonly GoalWatch[];
  windows: readonly WatchWindow[];
  /** Oldest first; the last reading per environment and check is the one that stands. */
  readings: readonly WatchReading[];
  /** Why the watch measures nothing, where that was the decision; null where it was not. */
  emptyReason: string | null;
}): WatchOutcome | null {
  const { goalRef } = input;
  const checks = input.checks.filter((c) => c.originRef === goalRef);
  const windows = input.windows.filter((w) => w.goalRef === goalRef);
  const watching = windows.filter((w) => w.settledAt === null).map((w) => w.environment);
  if (checks.length === 0) {
    if (input.emptyReason === null) return null;
    return { goalRef, outcome: 'none', checks: [], reason: input.emptyReason, watching: [] };
  }
  const settled = windows
    .filter((w) => w.settledAt !== null)
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));
  if (settled.length === 0) {
    if (windows.length === 0) return null;
    return { goalRef, outcome: 'watching', checks: [], reason: null, watching };
  }
  const newest = new Map<string, WatchReading>();
  for (const r of input.readings) if (r.goalRef === goalRef) newest.set(`${r.environment} ${r.checkId}`, r);
  const folded = checks.map((check) => foldCheck(check, settled, newest));
  const outcome = folded.some((c) => c.verdict === 'regressed')
    ? 'worse'
    : folded.every((c) => c.verdict === 'clean')
      ? 'worked'
      : 'unknown';
  return { goalRef, outcome, checks: folded, reason: null, watching };
}

function foldCheck(
  check: GoalWatch,
  settled: readonly WatchWindow[],
  newest: ReadonlyMap<string, WatchReading>,
): WatchOutcomeCheck {
  const read = settled.map((window) => ({ window, reading: newest.get(`${window.environment} ${check.id}`) ?? null }));
  const pick = (verdict: WatchCheckVerdict): (typeof read)[number] | undefined =>
    read.find((r) => r.reading?.verdict === verdict);
  const chosen = pick('regressed') ?? pick('clean');
  if (chosen?.reading) {
    const { window, reading } = chosen;
    return {
      ...base(check),
      verdict: reading.verdict,
      environment: window.environment,
      before: check.kind === 'measure' ? check.baselineValue : check.dryRunRows,
      after: check.kind === 'measure' ? reading.value : reading.rows,
      windowHours: windowHours(window),
      reason: reading.verdict === 'regressed' ? reading.detail : null,
    };
  }
  const reasons = read.map(({ window, reading }) =>
    reading === null
      ? `${window.environment}: the window settled without ever reading it`
      : `${window.environment}: ${reading.detail ?? 'the observation did not answer'}`,
  );
  return {
    ...base(check),
    verdict: 'unknown',
    environment: null,
    before: check.kind === 'measure' ? check.baselineValue : check.dryRunRows,
    after: null,
    windowHours: null,
    reason: reasons.join('; '),
  };
}

function base(check: GoalWatch): Pick<WatchOutcomeCheck, 'checkId' | 'title' | 'kind' | 'unit'> {
  return { checkId: check.id, title: check.title, kind: check.kind, unit: check.unit };
}

function windowHours(window: WatchWindow): number | null {
  const from = Date.parse(window.exposedAt ?? window.openedAt);
  const to = Date.parse(window.settledAt ?? window.settlesAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / HOUR_MS);
}

const OUTCOME_SAID: Record<WatchOutcome['outcome'], string> = {
  worked: 'It worked',
  worse: 'It made something worse',
  unknown: "Couldn't tell",
  none: 'Nothing was measured',
  watching: 'Still watching',
};

/**
 * The note **Discuss in Claude** writes to the goal's discussion file: the outcome, and per check what it
 * expected, before and after, and its query in a fence named by its source's language.
 * → docs/spec/29-post-deploy-watch.md#discussing-an-outcome
 */
export function watchOutcomeNote(input: {
  outcome: WatchOutcome;
  checks: readonly GoalWatch[];
  windows: readonly WatchWindow[];
  environments: readonly EnvironmentConfig[];
  pullRequests: readonly { number: number; title: string | null }[];
}): string {
  const { outcome } = input;
  const lines = [
    `**The post-deploy watch says: ${OUTCOME_SAID[outcome.outcome]}.** These are the environments' own answers; ` +
      'nothing has interpreted them, and a number that moved may have been moved by something else that shipped.',
    '',
  ];
  for (const folded of outcome.checks) {
    const check = input.checks.find((c) => c.originRef === outcome.goalRef && c.id === folded.checkId);
    if (check !== undefined) lines.push(...checkNote(folded, check, input.windows, input.environments));
  }
  const prs = input.pullRequests.map((p) => (p.title ? `#${String(p.number)} ${p.title}` : `#${String(p.number)}`));
  lines.push(`**Merged pull requests:** ${prs.length === 0 ? 'none recorded' : prs.join(', ')}.`);
  return lines.join('\n');
}

function checkNote(
  folded: WatchOutcomeCheck,
  check: GoalWatch,
  windows: readonly WatchWindow[],
  environments: readonly EnvironmentConfig[],
): string[] {
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const number = (n: number | null): string => (n === null ? 'not read' : `${String(n)}${unit}`);
  const on = folded.environment === null ? '' : ` on ${folded.environment}`;
  const over = folded.windowHours === null ? '' : ` over ${String(folded.windowHours)}h`;
  const window = windows.find((w) => w.goalRef === check.originRef && w.environment === folded.environment);
  const query =
    window === undefined
      ? check.query
      : withPeriod(check.query, window.exposedAt ?? window.openedAt, window.settledAt ?? window.settlesAt);
  const environment =
    environments.find((e) => e.name === folded.environment) ?? environments.find((e) => e.watch !== undefined);
  const language = declaredSource(environment?.watch, check.source)?.language ?? 'kql';
  return [
    `### ${check.title} — ${folded.verdict}${on}`,
    '',
    `**Expected:** ${expectation(check, unit)}`,
    `**Before → after:** ${number(folded.before)} → ${number(folded.after)}${on}${over}` +
      (check.kind === 'signal' ? ' (rows: the dry run before the merge, then the window)' : ''),
    ...(folded.reason === null ? [] : [`**Reading:** ${folded.reason}`]),
    ...(check.why === null ? [] : [`**Why it was declared:** ${check.why}`]),
    '',
    '```' + language,
    query,
    '```',
    '',
  ];
}

function expectation(check: GoalWatch, unit: string): string {
  if (check.kind === 'signal')
    return check.tolerate === 0 ? 'no matching rows at all' : `no more than ${String(check.tolerate)} matching rows`;
  const said: string[] = [];
  if (check.expectUnder !== null) said.push(`under ${String(check.expectUnder)}${unit}`);
  if (check.expectOver !== null) said.push(`over ${String(check.expectOver)}${unit}`);
  if (check.expectBaseline) said.push('no worse than its baseline');
  return said.join(' and ');
}
