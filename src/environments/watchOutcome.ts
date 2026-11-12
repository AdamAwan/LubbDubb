import type {
  GoalWatch,
  WatchCheckVerdict,
  WatchOutcome,
  WatchOutcomeCheck,
  WatchReading,
  WatchWindow,
} from '../types.js';
import type { EnvironmentConfig } from './policy.js';
import { settledWatchPeriod } from './exposure.js';
import { watchCheckBlock, watchCheckQuery, type WatchWindowReading } from './watchFinding.js';
import type { WatchStanding } from '../validation/watchAuthoring.js';

// → docs/spec/29-post-deploy-watch.md#the-outcome

const MINUTE_MS = 60 * 1000;

const HEADLINE: Record<WatchOutcome['outcome'], string> = {
  worked: 'It worked',
  worse: 'It made something worse',
  unknown: 'Couldn’t tell',
  none: 'Nothing was measured',
  unwritten: 'Not yet written',
  watching: 'Still watching',
};

/**
 * One goal's watch rolled up to one answer, folded over the readings `watchWindowReadings` decided stand —
 * never a second opinion on which reading that is.
 */
export function watchOutcome(input: {
  goalRef: string;
  /** The goal's live checks. */
  checks: readonly GoalWatch[];
  /** The goal's windows, each resolved against its checks by `watchWindowReadings`. */
  windows: readonly WatchWindowReading[];
  /** What a goal with no live checks reads: why nothing is measured, that its watch is owed, or nothing. */
  standing: WatchStanding;
}): WatchOutcome | null {
  const { goalRef, checks, windows } = input;
  const watching = windows.filter((w) => w.window.settledAt === null || w.awaiting).map((w) => w.window.environment);
  if (checks.length === 0) {
    const { standing } = input;
    if (standing === null) return null;
    return standing.kind === 'none'
      ? answer(goalRef, 'none', { reason: standing.reason })
      : answer(goalRef, 'unwritten', {});
  }
  const settled = windows
    .filter((w) => w.window.settledAt !== null && !w.awaiting)
    .sort((a, b) => (b.window.settledAt ?? '').localeCompare(a.window.settledAt ?? ''));
  if (settled.length === 0) {
    if (windows.length === 0) return null;
    return answer(goalRef, 'watching', { watching });
  }
  const folded = checks.map((check) => foldCheck(check, settled));
  const outcome = folded.some((c) => c.verdict === 'regressed')
    ? 'worse'
    : folded.every((c) => c.verdict === 'clean')
      ? 'worked'
      : 'unknown';
  return answer(goalRef, outcome, {
    checks: folded,
    watching,
    extendable: outcome === 'unknown' ? settled.map((w) => w.window.environment) : [],
  });
}

function answer(
  goalRef: string,
  outcome: WatchOutcome['outcome'],
  over: Partial<Pick<WatchOutcome, 'checks' | 'reason' | 'watching' | 'extendable'>>,
): WatchOutcome {
  return {
    goalRef,
    outcome,
    headline: HEADLINE[outcome],
    checks: [],
    reason: null,
    watching: [],
    discussable: outcome === 'worse' || outcome === 'unknown',
    extendable: [],
    ...over,
  };
}

function foldCheck(check: GoalWatch, settled: readonly WatchWindowReading[]): WatchOutcomeCheck {
  const read = settled.map(({ window, checks }) => ({
    window,
    reading: checks.find((c) => c.check.id === check.id)?.reading ?? null,
  }));
  const pick = (verdict: WatchCheckVerdict): { window: WatchWindow; reading: WatchReading } | undefined => {
    for (const { window, reading } of read) if (reading?.verdict === verdict) return { window, reading };
    return undefined;
  };
  const chosen = pick('regressed') ?? pick('clean');
  if (chosen) {
    const { window, reading } = chosen;
    return {
      ...base(check),
      verdict: reading.verdict,
      environment: window.environment,
      after: check.kind === 'measure' ? reading.value : reading.rows,
      windowSpan: windowSpan(window),
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
    after: null,
    windowSpan: null,
    reason: reasons.join('; '),
  };
}

function base(
  check: GoalWatch,
): Pick<WatchOutcomeCheck, 'checkId' | 'title' | 'kind' | 'unit' | 'before' | 'beforeEnvironment'> {
  const before = check.kind === 'measure' ? check.baselineValue : check.dryRunRows;
  return {
    checkId: check.id,
    title: check.title,
    kind: check.kind,
    unit: check.unit,
    before,
    beforeEnvironment: before === null ? null : check.dryRunEnvironment,
  };
}

function windowSpan(window: WatchWindow): string | null {
  const { since, until } = settledWatchPeriod(window);
  const from = Date.parse(since);
  const to = Date.parse(until);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  const minutes = Math.round((to - from) / MINUTE_MS);
  return minutes < 60 ? `${String(minutes)}m` : `${String(Math.round(minutes / 60))}h`;
}

/** Where the before number was read on another environment than the after, the environment it was read on. */
function beforeElsewhere(check: WatchOutcomeCheck): string | null {
  const { beforeEnvironment, environment } = check;
  return beforeEnvironment !== null && environment !== null && beforeEnvironment !== environment
    ? beforeEnvironment
    : null;
}

/**
 * What a settled outcome is a reading of: its answer and the windows it was folded from, as each settled. The
 * discuss route writes one note per key — a second press on the same reading is the note already written.
 */
export function watchOutcomeKey(outcome: WatchOutcome, windows: readonly WatchWindowReading[]): string {
  const settled = windows
    .flatMap(({ window }) => (window.settledAt === null ? [] : [`${window.environment} ${window.settledAt}`]))
    .sort();
  return `_Watch outcome ${outcome.outcome}, read off the windows settled ${settled.join(', ')}._`;
}

/**
 * The note **Discuss in Claude** writes to the goal's discussion file: the outcome, and per check what it
 * expected, before and after, and its query written as the bench row writes one.
 * → docs/spec/29-post-deploy-watch.md#discussing-an-outcome
 */
export function watchOutcomeNote(input: {
  outcome: WatchOutcome;
  /** The goal's live checks, as the outcome was folded from. */
  checks: readonly GoalWatch[];
  /** The goal's windows, as the outcome was folded from. */
  windows: readonly WatchWindowReading[];
  environments: readonly EnvironmentConfig[];
  pullRequests: readonly { number: number; title: string | null }[];
}): string {
  const { outcome } = input;
  const lines = [
    `**The post-deploy watch says: ${outcome.headline}.** These are the environments' own answers; ` +
      'nothing has interpreted them, and a number that moved may have been moved by something else that shipped.',
    '',
  ];
  for (const folded of outcome.checks) {
    const check = input.checks.find((c) => c.id === folded.checkId);
    if (check !== undefined) lines.push(...checkNote(folded, check, input.windows, input.environments));
  }
  const prs = input.pullRequests.map((p) => (p.title ? `#${String(p.number)} ${p.title}` : `#${String(p.number)}`));
  lines.push(`**Merged pull requests:** ${prs.length === 0 ? 'none recorded' : prs.join(', ')}.`);
  lines.push('', watchOutcomeKey(outcome, input.windows));
  return lines.join('\n');
}

function checkNote(
  folded: WatchOutcomeCheck,
  check: GoalWatch,
  windows: readonly WatchWindowReading[],
  environments: readonly EnvironmentConfig[],
): string[] {
  const unit = check.unit === null ? '' : ` ${check.unit}`;
  const number = (n: number | null): string => (n === null ? 'not read' : `${String(n)}${unit}`);
  const on = folded.environment === null ? '' : ` on ${folded.environment}`;
  const over = folded.windowSpan === null ? '' : ` over ${folded.windowSpan}`;
  const elsewhere = beforeElsewhere(folded);
  const before =
    elsewhere === null ? number(folded.before) : `${number(folded.before)} on ${elsewhere} before the merge`;
  const window = windows.find((w) => w.window.settledAt !== null && w.window.environment === folded.environment);
  return watchCheckBlock({
    heading: `${check.title} — ${folded.verdict}${on}`,
    body: [
      `**Expected:** ${expectation(check, unit)}`,
      `**Before → after:** ${before} → ${number(folded.after)}${on}${over}` +
        (check.kind === 'signal' ? ' (rows: the dry run before the merge, then the window)' : ''),
      ...(folded.reason === null ? [] : [`**Reading:** ${folded.reason}`]),
    ],
    why: check.why,
    lead: null,
    environment: folded.environment,
    query: watchCheckQuery(
      check,
      environments.find((e) => e.name === folded.environment),
      window === undefined ? null : settledWatchPeriod(window.window),
    ),
  });
}

/** What a check declared, in words: the bench row and the discussion note both say it this way. */
export function watchExpectation(check: GoalWatch): string {
  return expectation(check, check.unit === null ? '' : ` ${check.unit}`);
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
