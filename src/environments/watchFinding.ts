import { DESK_SETTLED, deskSettled } from '../benchSettlement.js';
import type { EnvironmentGate, GoalWatch, HumanTask, WatchCheckVerdict, WatchReading, WatchWindow } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

/**
 * What a finding does, as arithmetic.
 *
 * Three outlets and no fourth, and this file is the first two of them: the bench
 * row a regressed watch files, and the sentence the close-out carries about what
 * the watch says. The third — a bug — is an operator's click and lives in the
 * cockpit, because the route from a reading to new work is deliberately outside
 * the harness.
 *
 * Pure, and separate from the desk for {@link watchCheckVerdict}'s reason: what a
 * reading *means for a person* is the rule, and a rule that can only be exercised
 * by standing a server up is a rule nobody exercises.
 *
 * Three lines carry the module, and each fails silently if it goes the other way:
 *
 * **One row per window, never one per reading.** A `human_tasks` row per
 * 30-minute reading is 96 rows per check per environment, which is the Needs-you
 * rail burying its own asks under one goal's telemetry. The row is keyed on the
 * window, refreshed in place by `recordHumanTask`'s dedup, and its detail states
 * what the watch says *now*.
 *
 * **`unknown` is not a finding.** A window nobody could read has said nothing
 * about the work, and a row filed off one would put an expired credential in
 * front of a person as though it were a regression. It is the same rule as the
 * fold's, one layer up, and the same mistake if it is folded.
 *
 * **Nothing here is a `WorldEvent`.** `deliveryHold` expires a standing delivery
 * verdict on any world event matching the goal's issue ref, so a finding written
 * as one would un-park the goal it just reported on and hand the finished fix
 * back to the fleet. A bench row is not one, and neither is the close-out's
 * sentence. → `docs/spec/29-post-deploy-watch.md#what-a-finding-does`
 */

/** What a pass decided, as data — so the decisions are testable without a store. */
type WatchFindingStep =
  | { kind: 'file'; originRef: string; title: string; detail: string }
  | { kind: 'settle'; taskId: string; status: 'done'; resolution: string }
  | { kind: 'reopen'; taskId: string; detail: string };

/** One window's reading, reduced to the one word a surface with room for one draws. */
type WatchWindowVerdict = WatchCheckVerdict | 'unread';

/**
 * What a whole window says, in the one word the goal page's strip already folds
 * it to — and in the same direction, because two folds of one set of readings is
 * how a rail and a card come to disagree about a goal.
 *
 * **One-directional.** `regressed` is answered first, then an environment nobody
 * could read, then one nothing has asked yet; and only a window whose every check
 * came back clean says so. Nothing that is not a clean reading is ever folded into
 * an all-clear — the card underneath still draws every check, which is where a
 * goal whose signal passed and whose measure failed is legible as both.
 *
 * `unknown` is kept apart from `unread` here where the strip collapses the two
 * into *watch not read*, and the difference is what the surface has room for: a
 * stage has one line and a bench row has a sentence, and told apart, "could not be
 * read" is the one that names something an operator can go and fix.
 */
function watchWindowVerdict(readings: readonly (WatchCheckVerdict | null)[]): WatchWindowVerdict {
  if (readings.length === 0) return 'unread';
  if (readings.includes('regressed')) return 'regressed';
  if (readings.includes('unknown')) return 'unknown';
  if (readings.includes(null)) return 'unread';
  return 'clean';
}

/** One window with its checks' newest readings resolved — what both halves of this file work from. */
interface WatchWindowReading {
  window: WatchWindow;
  verdict: WatchWindowVerdict;
  /** The regressed checks, in document order, each with what it said in words. */
  regressed: { title: string; said: string }[];
}

/**
 * Resolve every window against the goal's declared checks and their newest
 * readings.
 *
 * The newest per `(window, check)` and nothing older, which is what makes the
 * bench row one row: a window is a series of readings and the ask is about where
 * it has got to, not about each answer along the way.
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
      // A window whose goal declares no live check at all reads *unread* rather
      // than clean: the checks an amendment dropped took their readings with them,
      // and a window with nothing left to ask has answered nothing.
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
 * The bench rows a regressed watch owes, and the standing ones a later reading
 * has answered.
 *
 * Filed while the window reads `regressed`, whether it is still open or has
 * settled — the spec's *settled or settling regressed*. A window still open is
 * the more useful of the two: the row arrives while somebody can still watch the
 * next reading come in.
 *
 * **The retraction is the harness's own**, and wears {@link DESK_SETTLED} like
 * every one of its siblings: a later reading inside an open window coming back
 * clean says the obligation is not owed *right now*, which is a different thing
 * from a person saying they have dealt with it. Without the marker
 * `recordHumanTask`'s dedup would refresh the operator's own settled row's detail
 * and leave it settled, and the finding would come back invisible.
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
      // Not a finding, and `unknown` is the case that matters: a window nobody
      // could read has said nothing about the work. A row already standing over a
      // reading that has since come back clean is retracted rather than left, so
      // the rail carries what the watch says now.
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
    // again the moment the reading regresses again. Reopened rather than re-filed,
    // because the dedup ignores status and would refresh a settled row's detail
    // and leave it settled.
    if (existing && existing.status !== 'open') {
      if (deskSettled(existing)) steps.push({ kind: 'reopen', taskId: existing.id, detail });
      continue;
    }
    steps.push({ kind: 'file', originRef: window.goalRef, title, detail });
  }
  return steps;
}

/**
 * Stable per window, because the dedup key is `(agent_id, origin_ref, title,
 * kind)` and stability is the whole of how one window keeps one row across 96
 * readings. It names the environment for the same reason: a goal watched in three
 * environments has three windows and three asks, and one title for all of them
 * would fold them into one row that keeps rewriting itself.
 */
function findingTitle(environment: string): string {
  return `The post-deploy watch on ${environment} is reporting a regression`;
}

/**
 * What the row says: which checks are outside what they declared, in the words the
 * reading itself used, and what the two ways out are.
 *
 * The numbers are quoted rather than summarised. No model read them and none will
 * — the whole subsystem's argument is that where a number needs interpreting, that
 * is a row on the bench with the number in front of a person.
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
 * nothing to say**.
 *
 * Reporting, and never gating: the row is filed and the ticket is closable
 * whatever this sentence says. That is the whole of the arrangement — a 48-hour
 * hold on every delivered goal would put every goal on the bench in a state
 * nobody can act on, which is the argument that keeps an environment gate off the
 * Needs-you rail one document over.
 *
 * A row settled early is therefore closed **in front of** the reading rather than
 * past it, which is `validate`'s arrangement exactly: the detail is rewritten on
 * every pulse, so the sentence an operator reads at the moment they close the
 * ticket is what the watch says then.
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
  // Never *clean so far*: a check nobody could read is not a check that passed,
  // and this is the reading that most looks like success.
  unknown: 'could not be read',
  unread: 'has not been read yet',
};

/**
 * The goals a `holds` opt-in has **cleared** for this obligation, or **null where
 * no environment declares one** — which is every deployment, since `holds` is off.
 *
 * {@link openedGoals}' shape exactly, and nullable for its reason: an empty set
 * would withhold the obligation on every deployment on earth and would look
 * identical to the feature working. A caller that folded null into an empty set is
 * the one mistake this shape exists to make impossible.
 *
 * **What clears a goal is a window that has *settled*, and nothing else.** Not an
 * arrival, and not an open window: a hold scoped to open windows would hold
 * nothing at all, because the obligation is filed on the delivery — pulses or days
 * before the work arrives anywhere — and both gates here hold a *new* row only. It
 * would read as configured and never withhold a thing.
 *
 * Satisfied by whichever declaring environment settles first, exactly as a gate is
 * satisfied by whichever the goal reaches first: two acceptance environments are
 * two entries, not a ranking. And an operator's *not waiting on an environment*
 * clears it too, for the reason it clears a gate — a goal whose work will never
 * reach an environment must not sit delivered with an empty bench for good.
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
