import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { EnvironmentGate, GoalWatch, HumanTask, WatchCheckVerdict, WatchReading, WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

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

interface RegressedCheck {
  title: string;
  said: string;
  why: string | null;
  query: string;
}

interface WatchWindowReading {
  window: WatchWindow;
  verdict: WatchWindowVerdict;
  regressed: RegressedCheck[];
}

/**
 * Resolve every window against the goal's declared checks and their newest
 * readings — the newest per `(window, check)` and nothing older, which is what
 * keeps the bench row one row.
 *
 * @public read by both the bench arm and the close-out's sentence, which must not disagree
 */
export function watchWindowReadings(input: {
  windows: readonly WatchWindow[];
  checks: readonly GoalWatch[];
  readings: readonly WatchReading[];
}): WatchWindowReading[] {
  const newest = new Map<string, WatchReading>();
  for (const r of input.readings) newest.set(`${r.goalRef} ${r.environment} ${r.checkId}`, r);
  return input.windows.map((window) => {
    const checks = input.checks.filter((c) => c.originRef === window.goalRef);
    const read = checks.map((c) => newest.get(`${window.goalRef} ${window.environment} ${c.id}`) ?? null);
    return {
      window,
      verdict: watchWindowVerdict(read.map((r) => r?.verdict ?? null)),
      regressed: checks.flatMap((check, i) => {
        const reading = read[i];
        if (reading?.verdict !== 'regressed') return [];
        return [
          {
            title: check.title,
            said: reading.detail ?? 'it read outside what the check declared',
            why: check.why,
            query: check.query,
          },
        ];
      }),
    };
  });
}

export function watchFindings(input: {
  readings: readonly WatchWindowReading[];
  existing: readonly HumanTask[];
}): WatchFindingStep[] {
  const byKey = new Map(input.existing.map((t) => [`${t.originRef ?? ''} ${t.title}`, t]));
  const steps: WatchFindingStep[] = [];
  for (const { window, verdict, regressed } of input.readings) {
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
    const detail = findingDetail(window, regressed);
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

function findingDetail(window: WatchWindow, regressed: RegressedCheck[]): string {
  const env = window.environment;
  const still =
    window.settledAt === null
      ? 'The window is still open, so these numbers are the newest reading and are rewritten on every pass.'
      : `The window has settled, so these are the last numbers ${env} gave.`;
  return [
    `This goal's work is live on **${env}**, and a check declared to watch it afterwards is reading outside what it ` +
      `declared. Nothing has interpreted this: the numbers below are ${env}'s own answers, which is why the row is ` +
      'in front of you rather than a fix in front of the fleet.',
    '',
    ...regressed.flatMap((c) => checkBlock(c, env)),
    `${still} Nothing is held by it — this row is yours to answer whenever you are ready.`,
    '',
    '**Raise a bug** hands the fleet these exact numbers as your own report, related back to this goal, and an agent ' +
      'picks the work up. **Done** says you have looked and this is not a regression. **Decline** says the same and ' +
      'that you are not acting on it. Either answer stands for good — the harness retracts and re-files its own row, ' +
      'never yours.',
  ].join('\n');
}

function checkBlock(check: RegressedCheck, environment: string): string[] {
  return [
    `**${check.title}**`,
    '',
    check.said,
    '',
    ...(check.why === null ? [] : [`**Why it was declared:** ${check.why}`, '']),
    `**To see the rows yourself**, this is the query the watch put to ${environment}, unchanged:`,
    '',
    '```',
    check.query,
    '```',
    '',
  ];
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
  const open = mine.some((r) => r.window.settledAt === null);
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
 * and an operator's *not waiting on an environment* clears it too.
 *
 * @public read by the two desks that file the obligations `holds` can name
 */
export function watchClearedGoals(
  gate: EnvironmentGate,
  environments: readonly EnvironmentConfig[],
  windows: readonly WatchWindow[],
  releases: readonly { goalRef: string }[],
): ReadonlySet<string> | null {
  const holding = new Set(environments.filter((e) => e.watch?.holds?.includes(gate)).map((e) => e.name));
  if (holding.size === 0) return null;
  const cleared = new Set(releases.map((r) => r.goalRef));
  for (const w of windows) if (w.settledAt !== null && holding.has(w.environment)) cleared.add(w.goalRef);
  return cleared;
}
