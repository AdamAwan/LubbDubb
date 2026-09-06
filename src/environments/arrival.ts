import { z } from 'zod';
import { optionalText, requiredBoolean } from '../server/validation.js';
import type { EnvironmentGate, EnvironmentGateRelease, GoalArrival, GoalEnvironmentReach } from '../types.js';
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
}): { arrival: GoalArrival; comment: boolean }[] {
  const byName = new Map(input.environments.map((e) => [e.name, e]));
  const floor = input.now - input.probeIntervalMs * ANNOUNCE_WINDOW_INTERVALS;
  const startedAsking = new Map<string, number>();
  for (const r of input.readings) {
    const at = Date.parse(r.observedAt);
    if (!Number.isFinite(at)) continue;
    const held = startedAsking.get(r.environment);
    if (held === undefined || at < held) startedAsking.set(r.environment, at);
  }
  const landedAt = new Map<string, number>();
  for (const l of input.landings) {
    const at = Date.parse(l.recordedAt);
    if (!Number.isFinite(at)) continue;
    const held = landedAt.get(l.goalRef);
    if (held === undefined || at > held) landedAt.set(l.goalRef, at);
  }
  const out: { arrival: GoalArrival; comment: boolean }[] = [];
  for (const arrival of input.arrivals) {
    if (arrival.announcedAt !== null) continue;
    const environment = byName.get(arrival.environment);
    const wanted = environment?.arrival?.comment === true;
    const seen = Date.parse(arrival.arrivedAt);
    const fresh = Number.isFinite(seen) && seen >= floor;
    const established = (startedAsking.get(arrival.environment) ?? input.now) < floor;
    const justLanded = (landedAt.get(arrival.goalRef) ?? -Infinity) >= floor;
    out.push({ arrival, comment: wanted && fresh && (established || justLanded) });
  }
  return out;
}

const MARKER = '<!-- lubbdubb:arrival -->\n_LubbDubb environments_';

export function arrivalComment(input: { environment: string; landings: number; at: string }): string {
  const merges = input.landings === 1 ? 'its merge is' : `all ${input.landings} of its merges are`;
  return (
    `${MARKER}\n\n**This work has reached \`${input.environment}\`** — ${merges} in it, ` +
    `as of ${input.at}.\n\nNothing is required here; this is the harness saying where the work got to.`
  );
}

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

const GATE_SAID: Record<EnvironmentGate, string> = {
  validate: 'the validation checks',
  close_out: 'the close-out',
};

function sentence(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
}
