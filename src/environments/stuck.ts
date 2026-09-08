import type { EnvironmentGateRelease, EnvironmentReading, GoalArrival, GoalLanding } from '../types.js';
import { environmentGateHold } from './arrival.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/24-environments.md

const STUCK_INTERVALS = 6;

interface StuckGoal {
  goalRef: string;
  environment: string;
  hold: string;
  absent: number;
  since: string;
}

export function stuckGoals(input: {
  delivered: readonly string[];
  shortfalled: ReadonlySet<string>;
  environments: EnvironmentConfig[];
  arrivals: readonly GoalArrival[];
  releases: readonly EnvironmentGateRelease[];
  landings: readonly GoalLanding[];
  readings: readonly EnvironmentReading[];
  probeIntervalMs: number;
  now: number;
}): StuckGoal[] {
  const gating = input.environments.filter((e) => (e.arrival?.opens ?? []).length > 0);
  if (gating.length === 0) return [];
  const floor = new Date(input.now - input.probeIntervalMs * STUCK_INTERVALS).toISOString();
  const out: StuckGoal[] = [];
  for (const goalRef of new Set(input.delivered)) {
    if (input.shortfalled.has(goalRef)) continue;
    const hold = environmentGateHold({
      goalRef,
      environments: input.environments,
      arrivals: input.arrivals,
      releases: input.releases,
    });
    if (hold === null) continue;
    const mine = input.landings.filter((l) => l.goalRef === goalRef && l.onIntegration !== false);
    if (mine.length === 0) continue;
    for (const environment of gating) {
      const verdicts = new Map(input.readings.filter((r) => r.environment === environment.name).map((r) => [r.sha, r]));
      let absent = 0;
      let since: string | null = null;
      for (const landing of mine) {
        const reading = verdicts.get(landing.sha);
        if (reading?.status !== 'absent' || reading.observedAt > floor) continue;
        absent += 1;
        if (since === null || reading.observedAt < since) since = reading.observedAt;
      }
      if (absent > 0 && since !== null) out.push({ goalRef, environment: environment.name, hold, absent, since });
    }
  }
  return out;
}

export function stuckSaid(stuck: StuckGoal): string {
  const merges = stuck.absent === 1 ? 'its merge is' : `${stuck.absent} of its merges are`;
  return (
    `${stuck.goalRef} is delivered and held: ${merges} still not in ${stuck.environment}, ` +
    `last read as absent since ${stuck.since}. ${stuck.hold}`
  );
}
