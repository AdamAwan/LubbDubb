import { z } from 'zod';
import { optionalText, requiredBoolean } from '../server/validation.js';
import type { EnvironmentGate, EnvironmentGateRelease, GoalArrival, GoalEnvironmentReach } from '../types.js';
import { bandOfEnvironment, bandSaid, environmentGroups, type EnvironmentGroup } from './groups.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/24-environments.md

export const GateReleaseBody = z
  .object({
    released: requiredBoolean('released must be a boolean'),
    note: optionalText('note'),
  })
  .refine((body) => !body.released || body.note !== undefined, {
    message: 'a release needs a note — it is the only account of why this goal stopped waiting',
  });

interface ArrivalToRecord {
  goalRef: string;
  environment: string;
  arrivedAt: string;
}

export function newArrivals(input: {
  reach: { goalRef: string; environments: GoalEnvironmentReach[] }[];
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

const ANNOUNCE_WINDOW_INTERVALS = 2;

export function announceableArrivals(input: {
  arrivals: readonly GoalArrival[];
  environments: EnvironmentConfig[];
  readings: readonly { environment: string; observedAt: string }[];
  landings: readonly { goalRef: string; recordedAt: string }[];
  probeIntervalMs: number;
  now: number;
}): Announcement[] {
  const byName = new Map(input.environments.map((e) => [e.name, e]));
  const bands = bandOfEnvironment(input.environments);
  const arrivedAt = environmentsByGoal(input.arrivals);
  const floor = input.now - input.probeIntervalMs * ANNOUNCE_WINDOW_INTERVALS;
  const startedAsking = earliestReadings(input.readings);
  const landedAt = latestLandings(input.landings);
  const speaker = speakers(input.arrivals, bands);
  const out: Announcement[] = [];
  for (const arrival of input.arrivals) {
    if (arrival.announcedAt !== null) continue;
    const band = bands.get(arrival.environment);
    const seen = Date.parse(arrival.arrivedAt);
    const fresh = Number.isFinite(seen) && seen >= floor;
    const established = (startedAsking.get(arrival.environment) ?? input.now) < floor;
    const justLanded = (landedAt.get(arrival.goalRef) ?? -Infinity) >= floor;
    /* A group is one place, so it is announced once — when the last of its environments takes
       the work. The earlier members are marked announced saying nothing, which is what keeps
       three regions of production from being three comments on one ticket. */
    const whole = band === undefined || band.environments.every((n) => arrivedAt.get(arrival.goalRef)?.has(n) === true);
    const speaks = band?.declared !== true || speaker.get(`${arrival.goalRef} ${band.name}`) === arrival.environment;
    const watched = fresh && whole && speaks && (established || justLanded);
    out.push(announcement(arrival, watched, byName.get(arrival.environment), band));
  }
  return out;
}

interface Announcement {
  arrival: GoalArrival;
  comment: boolean;
  workItemState: string | null;
  said: string;
}

function environmentsByGoal(arrivals: readonly GoalArrival[]): Map<string, Set<string>> {
  const arrivedAt = new Map<string, Set<string>>();
  for (const a of arrivals) {
    const held = arrivedAt.get(a.goalRef);
    if (held === undefined) arrivedAt.set(a.goalRef, new Set([a.environment]));
    else held.add(a.environment);
  }
  return arrivedAt;
}

function earliestReadings(readings: readonly { environment: string; observedAt: string }[]): Map<string, number> {
  const startedAsking = new Map<string, number>();
  for (const r of readings) {
    const at = Date.parse(r.observedAt);
    if (!Number.isFinite(at)) continue;
    const held = startedAsking.get(r.environment);
    if (held === undefined || at < held) startedAsking.set(r.environment, at);
  }
  return startedAsking;
}

function latestLandings(landings: readonly { goalRef: string; recordedAt: string }[]): Map<string, number> {
  const landedAt = new Map<string, number>();
  for (const l of landings) {
    const at = Date.parse(l.recordedAt);
    if (!Number.isFinite(at)) continue;
    const held = landedAt.get(l.goalRef);
    if (held === undefined || at > held) landedAt.set(l.goalRef, at);
  }
  return landedAt;
}

/* Of the band's arrivals still unsaid, the one that completed it — the latest to be read,
   and the only one that speaks. Both regions announcing in the pulse they finish together
   would be the same sentence said twice on one ticket. */
function speakers(arrivals: readonly GoalArrival[], bands: Map<string, EnvironmentGroup>): Map<string, string> {
  const speaker = new Map<string, string>();
  for (const arrival of arrivals) {
    if (arrival.announcedAt !== null) continue;
    const band = bands.get(arrival.environment);
    if (band?.declared !== true) continue;
    const key = `${arrival.goalRef} ${band.name}`;
    const held = speaker.get(key);
    const heldAt = held === undefined ? null : (arrivals.find((a) => a.environment === held)?.arrivedAt ?? null);
    if (heldAt === null || arrival.arrivedAt >= heldAt) speaker.set(key, arrival.environment);
  }
  return speaker;
}

function announcement(
  arrival: GoalArrival,
  watched: boolean,
  environment: EnvironmentConfig | undefined,
  band: EnvironmentGroup | undefined,
): Announcement {
  return {
    arrival,
    comment: watched && environment?.arrival?.comment === true,
    workItemState: watched ? (environment?.arrival?.workItemState ?? null) : null,
    said: band?.declared === true ? band.name : arrival.environment,
  };
}

const MARKER = '<!-- lubbdubb:arrival -->\n_LubbDubb environments_';

export function arrivalComment(input: { environment: string; landings: number; at: string }): string {
  const merges = input.landings === 1 ? 'its merge is' : `all ${input.landings} of its merges are`;
  return (
    `${MARKER}\n\n**This work has reached \`${input.environment}\`** — ${merges} in it, ` +
    `as of ${input.at}.\n\nNothing is required here; this is the harness saying where the work got to.`
  );
}

/**
 * A gate is opened by a **band**, never by one of its environments: three regions of production
 * are one place, so the work has reached production when all three hold it. An ungrouped
 * environment is a band of one, which is the behaviour before groups existed. Across bands it is
 * still an OR — two places that each open a gate open it independently.
 * → docs/spec/24-environments.md#groups
 */
export function openedGoals(
  gate: EnvironmentGate,
  environments: EnvironmentConfig[],
  arrivals: readonly GoalArrival[],
  releases: readonly EnvironmentGateRelease[],
): ReadonlySet<string> | null {
  const gating = gatingBands(gate, environments);
  if (gating.length === 0) return null;
  const arrivedAt = environmentsByGoal(arrivals);
  const open = new Set(releases.map((r) => r.goalRef));
  for (const [goalRef, reached] of arrivedAt)
    if (gating.some((band) => band.environments.every((name) => reached.has(name)))) open.add(goalRef);
  return open;
}

/** The bands whose environments open this gate. A group's members agree on `arrival`, so a band
 *  gates as a whole or not at all — `validateEnvironments` refuses the mixture. */
function gatingBands(gate: EnvironmentGate, environments: EnvironmentConfig[]): EnvironmentGroup[] {
  const opens = new Set(environments.filter((e) => e.arrival?.opens?.includes(gate)).map((e) => e.name));
  return environmentGroups(environments).filter((band) => band.environments.some((name) => opens.has(name)));
}

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
    for (const band of gatingBands(gate, input.environments)) names.add(bandSaid(band));
  }
  if (waiting.length === 0) return null;
  const where = [...names].join(' or ');
  return `${sentence(waiting)} ${waiting.length === 1 ? 'is' : 'are'} waiting for this work to reach ${where}.`;
}

const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the validation checks',
  close_out: 'the close-out',
};

function sentence(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
