import { z } from 'zod';
import { optionalText, requiredBoolean } from '../server/validation.js';
import type { EnvironmentGate, EnvironmentGateRelease, GoalArrival, GoalEnvironmentReach } from '../types.js';
import type { EnvironmentConfig } from './policy.js';

/**
 * The operator's "this goal is not waiting on an environment", as a request body
 * — here rather than in the route that reads it, because what it encodes is the
 * rule and not the routing.
 *
 * The `.refine` is the rule: a release **must say why**, where every other
 * operator verdict's summary is optional. The others record a judgement about the
 * work; this one records a decision to stop waiting for evidence, on a goal that
 * will then read as closed-out with nothing at all on the glass to say the
 * environment never confirmed it. The note is the whole of what keeps that
 * legible six weeks later.
 */
export const GateReleaseBody = z
  .object({
    released: requiredBoolean('released must be a boolean'),
    note: optionalText('note'),
  })
  .refine((body) => !body.released || body.note !== undefined, {
    message: 'a release needs a note — it is the only account of why this goal stopped waiting',
  });

/** One goal's whole work, newly confirmed in one environment. */
interface ArrivalToRecord {
  goalRef: string;
  environment: string;
  arrivedAt: string;
}

/**
 * Which goals have just arrived somewhere — every `(goal, environment)` the fold
 * calls `reached` and the store has no row for.
 *
 * **An arrival is a moment and reach is a status**, which is the whole reason
 * anything is written down. {@link goalReach} can say a goal *is* in testUk on
 * every pulse from now until the heat death; only a row can say it has just got
 * there, and only a row keeps the ticket to one comment rather than one every
 * five minutes.
 *
 * `at` is required rather than assumed: it is the reading that confirmed the
 * goal's *last* landing, so it is when the whole goal arrived rather than when the
 * first part of it did, and it is what {@link announceableArrivals} reads to tell
 * an arrival it watched happen from one it merely discovered.
 */
export function newArrivals(input: {
  /** One entry per goal, exactly as the cockpit's own fold produces them. */
  reach: { goalRef: string; environments: GoalEnvironmentReach[] }[];
  /** Every arrival already recorded — `Store.listGoalArrivals()`. */
  recorded: readonly GoalArrival[];
}): ArrivalToRecord[] {
  const held = new Set(input.recorded.map((a) => `${a.goalRef} ${a.environment}`));
  const out: ArrivalToRecord[] = [];
  for (const goal of input.reach)
    for (const env of goal.environments) {
      if (env.status !== 'reached' || env.at === null) continue;
      if (held.has(`${goal.goalRef} ${env.environment}`)) continue;
      out.push({ goalRef: goal.goalRef, environment: env.environment, arrivedAt: env.at });
    }
  return out;
}

/**
 * How stale a confirming reading may be and still be announced, as a multiple of
 * the probe interval.
 *
 * The harness comments on an arrival it **watched happen**, never on one it
 * discovered. Without that line the first pulse after this ships — or after an
 * operator adds `arrival.comment` to an environment that has been probing for a
 * month — posts a comment on every ticket already in it, which is the same
 * backfill-on-boot failure a nullable column has and reads on the ticket as the
 * feature having lost its mind.
 *
 * Two intervals rather than one: a landing confirmed on the pulse before this one
 * is an arrival this harness saw, and a probe pass that ran long must not turn
 * that into silence. → `docs/spec/24-environments.md#announcing-an-arrival`
 */
const ANNOUNCE_WINDOW_INTERVALS = 2;

/**
 * The arrivals this pulse owes an announcement, and what each owes.
 *
 * Every unannounced arrival is returned, including the ones with nothing to say —
 * the caller stamps them all. That is deliberate: an environment that grows
 * `arrival.comment` later then announces its *next* arrival rather than its whole
 * history, and the stamp is the only thing that can say so.
 */
export function announceableArrivals(input: {
  arrivals: readonly GoalArrival[];
  environments: EnvironmentConfig[];
  probeIntervalMs: number;
  now: number;
}): { arrival: GoalArrival; comment: boolean }[] {
  const byName = new Map(input.environments.map((e) => [e.name, e]));
  const floor = input.now - input.probeIntervalMs * ANNOUNCE_WINDOW_INTERVALS;
  const out: { arrival: GoalArrival; comment: boolean }[] = [];
  for (const arrival of input.arrivals) {
    if (arrival.announcedAt !== null) continue;
    const environment = byName.get(arrival.environment);
    // An environment the operator has since removed still gets its arrival
    // stamped: the row is history, and leaving it unstamped would announce it
    // if the name ever came back.
    const wanted = environment?.arrival?.comment === true;
    const seen = Date.parse(arrival.arrivedAt);
    const fresh = Number.isFinite(seen) && seen >= floor;
    out.push({ arrival, comment: wanted && fresh });
  }
  return out;
}

/** Identifies the comment as the harness's, for anyone reading the thread cold. */
const MARKER = '<!-- lubbdubb:arrival -->\n_LubbDubb environments_';

/**
 * What an arrival says on the ticket. Pure, and one comment per arrival rather
 * than one living comment edited in place — unlike the assay's, which is a
 * standing state. This is a thing that happened at a time, and a timeline of four
 * short comments is what a reader wants from "where did this get to"; an edited
 * comment would silently rewrite the record of the last environment each time.
 */
export function arrivalComment(input: { environment: string; landings: number; at: string }): string {
  const merges = input.landings === 1 ? 'its merge is' : `all ${input.landings} of its merges are`;
  return (
    `${MARKER}\n\n**This work has reached \`${input.environment}\`** — ${merges} in it, ` +
    `as of ${input.at}.\n\nNothing is required here; this is the harness saying where the work got to.`
  );
}

/**
 * The goals whose `gate` obligation is open, or **null when nothing gates it**.
 *
 * Null is the whole compatibility story: with no environment declaring a gate,
 * the desks behave exactly as they did — the obligation is filed on the delivery
 * and nothing waits for a deployment. A caller that folded null into an empty set
 * would withhold every bench row on every deployment that never configured an
 * environment, and would look identical to the feature working.
 *
 * A gate declared on more than one environment is satisfied by whichever the goal
 * reaches first: two acceptance environments are two entries, not a ranking.
 */
export function openedGoals(
  gate: EnvironmentGate,
  environments: EnvironmentConfig[],
  arrivals: readonly GoalArrival[],
  releases: readonly EnvironmentGateRelease[],
): ReadonlySet<string> | null {
  const gating = new Set(environments.filter((e) => e.arrival?.opens?.includes(gate)).map((e) => e.name));
  if (gating.size === 0) return null;
  const open = new Set(releases.map((r) => r.goalRef));
  for (const arrival of arrivals) if (gating.has(arrival.environment)) open.add(arrival.goalRef);
  return open;
}

/**
 * Why a delivered goal's bench rows are waiting, in the operator's own terms, or
 * null when nothing is holding them.
 *
 * The sentence exists because the hold is otherwise the quietest thing the
 * harness does: no row is filed, so an operator sees a delivered goal with an
 * empty bench and nothing at all to say the harness is waiting rather than
 * finished. It names the environments that would open it, since the useful next
 * question is always "what is it waiting for" and the answer is configuration
 * they may not remember writing.
 */
export function environmentGateHold(input: {
  goalRef: string;
  environments: EnvironmentConfig[];
  arrivals: readonly GoalArrival[];
  releases: readonly EnvironmentGateRelease[];
}): string | null {
  const waiting: string[] = [];
  const names = new Set<string>();
  for (const gate of ['validate', 'close_out'] as const) {
    const open = openedGoals(gate, input.environments, input.arrivals, input.releases);
    if (open === null || open.has(input.goalRef)) continue;
    waiting.push(GATE_SAID[gate]);
    for (const env of input.environments) if (env.arrival?.opens?.includes(gate)) names.add(env.name);
  }
  if (waiting.length === 0) return null;
  const where = [...names].join(' or ');
  return `${sentence(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting for this work to reach ${where}.`;
}

/** What each gate holds, named as the thing an operator would otherwise go looking for. */
const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the validation checks',
  close_out: 'the close-out',
};

function sentence(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
