import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { EnvironmentGate, GoalWatch, HumanTask, WatchCheckVerdict, WatchReading, WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

/**
 * What a finding does, as arithmetic: the bench row a regressed watch files, and the
 * sentence the close-out carries. One row per window, never one per reading; `unknown` is
 * not a finding; nothing here is a `WorldEvent`.
 * → `docs/spec/29-post-deploy-watch.md#what-a-finding-does`
 */

/** What a pass decided, as data — so the decisions are testable without a store. */
type WatchFindingStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

/** One window's reading, reduced to the one word a surface with room for one draws. */
type WatchWindowVerdict = WatchCheckVerdict | 'unread';

/**
 * What a whole window says, folded in the same direction as the goal page's strip.
 * One-directional: nothing that is not a clean reading is ever folded into an all-clear.
 */
function watchWindowVerdict(readings: readonly (WatchCheckVerdict | null)[]): WatchWindowVerdict {
  if (readings.length === 0) return 'unread';
  if (readings.includes('regressed')) return 'regressed';
  if (readings.includes('unknown')) return 'unknown';
  if (readings.includes(null)) return 'unread';
  return 'clean';
}

/**
 * One window with its checks' newest readings resolved — what both halves of this file work
 * from.
 */
interface WatchWindowReading {
  window: WatchWindow;
  verdict: WatchWindowVerdict;
  /** The regressed checks, in document order, each with what it said in words. */
  regressed: { title: string; said: string }[];
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
  /** Every live check, `Store.listGoalWatches()`. */
  checks: readonly GoalWatch[];
  /** Every reading, oldest first — `Store.listWatchReadings()`. */
  readings: readonly WatchReading[];
}): WatchWindowReading[] {
  const newest = new Map<string, WatchReading>();
  for (const r of input.readings) newest.set(`${r.goalRef} ${r.environment} ${r.checkId}`, r);
  return input.windows.map((window) => {
    const checks = input.checks.filter((c) => c.originRef === window.goalRef);
    const read = checks.map((c) => newest.get(`${window.goalRef} ${window.environment} ${c.id}`) ?? null);
    return {
      window,
      // A window whose goal declares no live check reads *unread*, not clean:
      // one with nothing left to ask has answered nothing.
      verdict: watchWindowVerdict(read.map((r) => r?.verdict ?? null)),
      regressed: checks.flatMap((check, i) => {
        const reading = read[i];
        if (reading?.verdict !== 'regressed') return [];
        return [{ title: check.title, said: reading.detail ?? 'it read outside what the check declared' }];
      }),
    };
  });
}

/**
 * The bench rows a regressed watch owes, and the standing ones a later reading has
 * answered. A retraction here must wear {@link DESK_SETTLED} — without the marker the
 * dedup refreshes an operator's settled row in place and the finding comes back invisible.
 */
export function watchFindings(input: {
  readings: readonly WatchWindowReading[];
  /** The `watch` tasks already on these goals, settled ones included. */
  existing: readonly HumanTask[];
}): WatchFindingStep[] {
  const byKey = new Map(input.existing.map((t) => [`${t.originRef ?? ''} ${t.title}`, t]));
  const steps: WatchFindingStep[] = [];
  for (const { window, verdict, regressed } of input.readings) {
    const title = findingTitle(window.environment);
    const existing = byKey.get(`${window.goalRef} ${title}`);
    if (verdict !== 'regressed') {
      // Not a finding — a window nobody could read has said nothing about the
      // work. A standing row whose reading has since come back clean is retracted.
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
    // An operator's own verdict stands forever; one the harness retracted is owed
    // again. Reopened rather than re-filed: the dedup ignores status and would
    // refresh a settled row's detail and leave it settled.
    if (existing && existing.status !== 'open') {
      if (deskSettled(existing)) steps.push({ kind: 'reopen', taskId: existing.id, detail });
      continue;
    }
    steps.push({ kind: 'file', originRef: window.goalRef, title, detail });
  }
  return steps;
}

/**
 * Stable per window and naming the environment: the dedup key is `(agent_id, origin_ref,
 * title, kind)`, so stability is how one window keeps one row across many readings, and one
 * title for three environments would fold three asks into one.
 */
function findingTitle(environment: string): string {
  return `The post-deploy watch on ${environment} is reporting a regression`;
}

/**
 * What the row says: which checks read outside what they declared, in the reading's own
 * words, and the two ways out. Numbers are quoted, never summarised — no model reads them.
 */
function findingDetail(window: WatchWindow, regressed: { title: string; said: string }[]): string {
  const still = window.settledAt === null ? 'The window is still open' : 'The window has settled';
  return [
    `**${window.environment}** is answering outside what this goal's watch declared.`,
    '',
    ...regressed.map((c) => `- **${c.title}** — ${c.said}`),
    '',
    `${still}, and nothing is held by it. Raising a bug from this row hands the fleet these numbers as your own ` +
      'report; marking it done says you have looked and it is not a regression.',
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
  const open = mine.some((r) => r.window.settledAt === null);
  return (
    `**The post-deploy watch says:** ${said.join(', ')}.` +
    (open ? ' It is still open, and holds nothing — this row is yours to close whenever you are ready.' : '')
  );
}

/** One window's verdict in the operator's own words, never in a clean one's vocabulary. */
const WATCH_SAID: Record<WatchWindowVerdict, string> = {
  clean: 'read every declared check clean',
  regressed: 'is answering outside what was declared',
  // Never *clean so far*: a check nobody could read is not a check that passed.
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
