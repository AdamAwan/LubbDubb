import type { EnvironmentReading, GoalEnvironmentReach, GoalLanding, Plan, PlanPart, WorkNode } from '../types.js';
import { partSettled } from '../plans/parts.js';
import { unattributedMerges } from './landings.js';
import type { EnvironmentConfig } from './policy.js';

// → docs/spec/24-environments.md

interface GoalReachInput {
  goalRef: string;
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  environments: EnvironmentConfig[];
  unattributed: number;
  outstanding: number;
}

export function goalReach(input: GoalReachInput): GoalEnvironmentReach[] {
  const landings = input.landings.filter((l) => l.goalRef === input.goalRef);
  const total = landings.length + input.unattributed + input.outstanding;
  return input.environments.map(({ name: environment, arrival }) => {
    const verdicts = readingsFor(input.readings, environment);
    let reached = 0;
    let absent = input.outstanding;
    let latest: string | null = null;
    for (const landing of landings) {
      const reading = verdicts.get(landing.sha);
      if (reading?.status === 'reached') {
        reached += 1;
        if (latest === null || reading.observedAt > latest) latest = reading.observedAt;
      } else if (reading?.status === 'absent') absent += 1;
    }
    const unresolved = total - reached - absent;
    return {
      environment,
      status: rollUpReach({ total, reached, unresolved }),
      landed: reached,
      total,
      at: reached === total && total > 0 ? latest : null,
      opens: arrival?.opens ?? [],
    };
  });
}

export function allGoalReach(input: {
  landings: GoalLanding[];
  readings: EnvironmentReading[];
  nodes: WorkNode[];
  landed: ReadonlySet<number>;
  plans: Plan[];
  parts: PlanPart[];
  environments: EnvironmentConfig[];
  held?: ReadonlySet<string>;
}): { goalRef: string; environments: GoalEnvironmentReach[] }[] {
  const goalRefs = new Set(input.landings.map((l) => l.goalRef));
  for (const node of input.nodes) if (node.kind === 'issue') goalRefs.add(node.ref);
  for (const goalRef of input.held ?? []) goalRefs.add(goalRef);
  const out: { goalRef: string; environments: GoalEnvironmentReach[] }[] = [];
  for (const goalRef of goalRefs) {
    const unattributed = unattributedMerges(goalRef, input.nodes, input.landed);
    if (unattributed === 0 && !input.landings.some((l) => l.goalRef === goalRef) && input.held?.has(goalRef) !== true)
      continue;
    const outstanding = partsOwed(goalRef, input.plans, input.parts);
    out.push({ goalRef, environments: goalReach({ ...input, goalRef, unattributed, outstanding }) });
  }
  return out;
}

function partsOwed(goalRef: string, plans: Plan[], parts: PlanPart[]): number {
  const owning = new Set(plans.filter((p) => p.originRef === goalRef && p.status !== 'abandoned').map((p) => p.id));
  let owed = 0;
  for (const part of parts) {
    if (!owning.has(part.planId)) continue;
    if (part.status === 'retired' || partSettled(part)) continue;
    if (part.expectedKind !== null && part.expectedKind !== 'code') continue;
    owed += 1;
  }
  return owed;
}

export function rollUpReach(counts: {
  total: number;
  reached: number;
  unresolved: number;
}): GoalEnvironmentReach['status'] {
  if (counts.total === 0) return 'absent';
  if (counts.reached === counts.total) return 'reached';
  if (counts.reached > 0) return 'partial';
  return counts.unresolved > 0 ? 'unknown' : 'absent';
}

function readingsFor(readings: EnvironmentReading[], environment: string): Map<string, EnvironmentReading> {
  const out = new Map<string, EnvironmentReading>();
  for (const r of readings) if (r.environment === environment) out.set(r.sha, r);
  return out;
}
