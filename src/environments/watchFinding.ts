import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type {
  EnvironmentGate,
  GoalWatch,
  HumanTask,
  WatchAsk,
  WatchCheckVerdict,
  WatchReading,
  WatchSourceLanguage,
  WatchWindow,
} from '../types.js';
import { groupBy } from '../primitives.js';
import type { EnvironmentConfig } from './policy.js';
import { watchQueryUrl } from './watchQueryUrl.js';
import { withPeriod } from '../validation/watchQueryShape.js';
import { watchPeriod } from './exposure.js';
import { declaredSource } from './watchSource.js';
import type { WatchPeriod } from './watchResult.js';

// → docs/spec/24-environments.md

type WatchFindingStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

type WatchWindowVerdict = WatchCheckVerdict | 'unread';

function watchWindowVerdict(readings: readonly (WatchCheckVerdict | null)[]): WatchWindowVerdict {
  if (readings.length === 0) return 'unread';
  if (readings.includes('regressed')) return 'regressed';
  if (readings.includes('unknown')) return 'unknown';
  if (readings.includes(null)) return 'unread';
  return 'clean';
}

/** A check's query as the operator would run it: the period filled in, its source's language, and where to run it. */
export interface WatchCheckQuery {
  query: string;
  /** A signal's presence query, filled in the same way; null for a check that carries none. */
  presence: string | null;
  /** The fence's info string: the language of the source the check read. */
  language: WatchSourceLanguage;
  queryUrl: string | null;
}

/**
 * The query a check put to one environment over `period`, or its declared text where no window is to
 * hand — never a source borrowed from another environment.
 */
export function watchCheckQuery(
  check: GoalWatch,
  environment: EnvironmentConfig | undefined,
  period: WatchPeriod | null,
): WatchCheckQuery {
  const fill = (text: string): string => (period === null ? text : withPeriod(text, period.since, period.until));
  const query = fill(check.query);
  const source = declaredSource(environment?.watch, check.source);
  return {
    query,
    presence: check.presence === null ? null : fill(check.presence),
    language: source?.language ?? 'kql',
    queryUrl: watchQueryUrl(source?.queryUrl, query),
  };
}

interface RegressedCheck {
  check: GoalWatch;
  said: string;
  query: WatchCheckQuery;
}

/** One check and the reading that stands for it on a window; null where the window never read it. */
interface WatchCheckReading {
  check: GoalWatch;
  reading: WatchReading | null;
  /** A person is asked for this window's closing reading of it, and has not answered yet. */
  waitingOnYou: boolean;
}

export interface WatchWindowReading {
  window: WatchWindow;
  verdict: WatchWindowVerdict;
  /**
   * Some check's closing reading is asked of a person and still in grace: the window has not settled
   * for the outcome. → docs/spec/29-post-deploy-watch.md#a-source-only-the-operator-can-run
   */
  awaiting: boolean;
  /**
   * The window has settled **and** awaits no person's reading — the settledness every reader of the
   * outcome, the close-out's sentence and the bench row goes by, never `window.settledAt` alone.
   */
  settled: boolean;
  /** Every one of the goal's checks, in declared order, with its standing reading here. */
  checks: WatchCheckReading[];
  regressed: RegressedCheck[];
}

/**
 * Resolve every window against the goal's declared checks and their newest
 * readings — the newest per `(window, check)` and nothing older, which is what
 * keeps the bench row one row. The one place a reading is decided to stand: the
 * window view and the outcome read `checks` off this rather than re-deriving it.
 *
 * @public read by the bench arm, the close-out's sentence, the window view and the outcome, which must not disagree
 */
export function watchWindowReadings(input: {
  windows: readonly WatchWindow[];
  checks: readonly GoalWatch[];
  readings: readonly WatchReading[];
  environments?: readonly EnvironmentConfig[];
  /** The `watch_reading` asks still open (`openWatchAsks`); only a closing one holds a window. */
  waiting: readonly WatchAsk[];
}): WatchWindowReading[] {
  const newest = new Map<string, WatchReading>();
  for (const r of input.readings) newest.set(`${r.goalRef} ${r.environment} ${r.checkId}`, r);
  const waiting = new Set(
    input.waiting.filter((a) => a.ask === 'closing').map((a) => `${a.goalRef} ${a.environment} ${a.checkId}`),
  );
  const checksByGoal = groupBy(input.checks, (c) => c.originRef);
  return input.windows.map((window) => {
    const checks = (checksByGoal.get(window.goalRef) ?? []).map((check) => ({
      check,
      reading: newest.get(`${window.goalRef} ${window.environment} ${check.id}`) ?? null,
      waitingOnYou: waiting.has(`${window.goalRef} ${window.environment} ${check.id}`),
    }));
    const awaiting = checks.some((c) => c.waitingOnYou);
    return {
      window,
      verdict: watchWindowVerdict(checks.map((c) => c.reading?.verdict ?? null)),
      awaiting,
      settled: window.settledAt !== null && !awaiting,
      checks,
      regressed: checks.flatMap(({ check, reading }) => {
        if (reading?.verdict !== 'regressed') return [];
        const environment = input.environments?.find((e) => e.name === window.environment);
        return [
          {
            check,
            said: reading.detail ?? 'it read outside what the check declared',
            query: watchCheckQuery(check, environment, watchPeriod(window, reading.readAt)),
          },
        ];
      }),
    };
  });
}

/**
 * A check written out for a person to read: its heading, what is said about it, why it was declared,
 * its query fenced in its source's language with the period filled in, and where to run it. The bench
 * row and the outcome's discussion note both write a check this way.
 */
export function watchCheckBlock(block: {
  heading: string;
  body: readonly string[];
  why: string | null;
  lead: string | null;
  /** Where given, the presence query is written under the check's own, led by this. */
  presenceLead?: string;
  environment: string | null;
  query: WatchCheckQuery;
}): string[] {
  const { query, environment } = block;
  return [
    `### ${block.heading}`,
    '',
    ...block.body,
    '',
    ...(block.why === null ? [] : [`**Why it was declared:** ${block.why}`, '']),
    ...(block.lead === null ? [] : [block.lead, '']),
    '```' + query.language,
    query.query,
    '```',
    '',
    ...(query.queryUrl === null || environment === null ? [] : [`[Run it on ${environment} ↗](${query.queryUrl})`, '']),
    ...(block.presenceLead === undefined || query.presence === null
      ? []
      : [block.presenceLead, '', '```' + query.language, query.presence, '```', '']),
  ];
}

export function watchFindings(input: {
  readings: readonly WatchWindowReading[];
  existing: readonly HumanTask[];
}): WatchFindingStep[] {
  const byKey = new Map(input.existing.map((t) => [`${t.originRef ?? ''} ${t.title}`, t]));
  const steps: WatchFindingStep[] = [];
  for (const { window, verdict, regressed, settled } of input.readings) {
    const title = findingTitle(window.environment);
    const existing = byKey.get(`${window.goalRef} ${title}`);
    if (verdict !== 'regressed') {
      if (existing?.status === 'open' && verdict === 'clean')
        steps.push({
          kind: 'settle',
          taskId: existing.id,
          status: 'done',
          resolution: DESK_SETTLED + `${window.environment} has since read every check clean`,
        });
      continue;
    }
    const detail = findingDetail(window, settled, regressed);
    if (existing && existing.status !== 'open') {
      if (deskSettled(existing)) steps.push({ kind: 'reopen', taskId: existing.id, detail });
      continue;
    }
    steps.push({ kind: 'file', originRef: window.goalRef, title, detail });
  }
  return steps;
}

function findingTitle(environment: string): string {
  return `The post-deploy watch on ${environment} is reporting a regression`;
}

function findingDetail(window: WatchWindow, settled: boolean, regressed: RegressedCheck[]): string {
  const env = window.environment;
  const still = !settled
    ? 'The window is still open, so these numbers are the newest reading and are rewritten on every pass.'
    : `The window has settled, so these are the last numbers ${env} gave.`;
  return [
    `This goal's work is live on **${env}**, and a check declared to watch it afterwards is reading outside what it ` +
      `declared. Nothing has interpreted this: the numbers below are ${env}'s own answers, which is why the row is ` +
      'in front of you rather than a fix in front of the fleet.',
    '',
    ...regressed.flatMap((c) =>
      watchCheckBlock({
        heading: c.check.title,
        body: [c.said],
        why: c.check.why,
        lead:
          `**To see the rows yourself**, this is the query the watch put to ${env}, with the period it read ` +
          'over — from the moment the work arrived — filled in where the declaration carried its time bounds:',
        environment: env,
        query: c.query,
      }),
    ),
    `${still} Nothing is held by it — this row is yours to answer whenever you are ready.`,
    '',
    '**Raise a bug** hands the fleet these exact numbers as your own report, related back to this goal, and an agent ' +
      'picks the work up. **Done** says you have looked and this is not a regression. **Decline** says the same and ' +
      'that you are not acting on it. Either answer stands for good — the harness retracts and re-files its own row, ' +
      'never yours.',
  ].join('\n');
}

/**
 * What the close-out's detail says about the watch, or **null where there is
 * nothing to say**. Reporting, never gating: the row is filed and the ticket is
 * closable whatever this sentence says, and the detail is rewritten every pulse.
 * → `docs/spec/20-validation.md#saying-so-on-the-bench`
 *
 * @public read by the close-out pass, which carries it and does not act on it
 */
export function watchCloseOutLine(goalRef: string, readings: readonly WatchWindowReading[]): string | null {
  const mine = readings.filter((r) => r.window.goalRef === goalRef);
  if (mine.length === 0) return null;
  const said = mine.map((r) => `${r.window.environment} ${WATCH_SAID[r.verdict]}`);
  const open = mine.some((r) => !r.settled);
  return (
    `**The post-deploy watch says:** ${said.join(', ')}.` +
    (open ? ' It is still open, and holds nothing — this row is yours to close whenever you are ready.' : '')
  );
}

const WATCH_SAID: Record<WatchWindowVerdict, string> = {
  clean: 'read every declared check clean',
  regressed: 'is answering outside what was declared',
  unknown: 'could not be read',
  unread: 'has not been read yet',
};

/**
 * The goals a `holds` opt-in has **cleared** for this obligation, or **null where
 * no environment declares one**. Never fold null into an empty set: an empty set
 * withholds the obligation everywhere and looks identical to the feature working.
 *
 * Only a *settled* window clears a goal (a hold scoped to open windows would
 * withhold nothing), satisfied by whichever declaring environment settles first,
 * and an operator's *not waiting on an environment* clears it too. A window whose
 * closing reading is still asked of a person has not answered, so it clears nothing.
 *
 * @public read by the two desks that file the obligations `holds` can name
 */
export function watchClearedGoals(
  gate: EnvironmentGate,
  environments: readonly EnvironmentConfig[],
  windows: readonly WatchWindow[],
  releases: readonly { goalRef: string }[],
  waiting: () => readonly WatchAsk[],
): ReadonlySet<string> | null {
  const holding = new Set(environments.filter((e) => e.watch?.holds?.includes(gate)).map((e) => e.name));
  if (holding.size === 0) return null;
  const awaited = new Set(
    waiting()
      .filter((a) => a.ask === 'closing')
      .map((a) => `${a.goalRef} ${a.environment}`),
  );
  const cleared = new Set(releases.map((r) => r.goalRef));
  for (const w of windows)
    if (w.settledAt !== null && holding.has(w.environment) && !awaited.has(`${w.goalRef} ${w.environment}`))
      cleared.add(w.goalRef);
  return cleared;
}
