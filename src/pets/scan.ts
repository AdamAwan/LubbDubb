import type { Store } from '../store/store.js';
import type { PetActionKind } from '../types.js';

// → docs/spec/22-pets.md

interface PetActionCandidate {
  kind: PetActionKind;
  ref: string;
  at: string;
}

export function collectActions(store: Store): PetActionCandidate[] {
  const out: PetActionCandidate[] = [];

  for (const escalation of store.escalations.listEscalations()) {
    if (escalation.answeredAt !== null) out.push({ kind: 'escalation', ref: escalation.id, at: escalation.answeredAt });
  }

  for (const task of store.humanTasks.listHumanTasks(ALL)) {
    if (task.kind === 'ask' && task.status === 'done' && task.resolvedAt !== null)
      out.push({ kind: 'human-task', ref: task.id, at: task.resolvedAt });
  }

  for (const plan of store.plans.listPlans()) {
    if (plan.status === 'active' || plan.status === 'complete')
      out.push({ kind: 'plan', ref: plan.id, at: plan.updatedAt });
  }

  for (const landing of store.landings.listStackLandings(ALL)) {
    out.push({ kind: 'landing', ref: landing.id, at: landing.createdAt });
  }

  for (const job of store.jobs.listJobs(ALL)) {
    if (job.originRef === null) out.push({ kind: 'job', ref: job.id, at: job.createdAt });
  }

  const upgrade = store.upgrades.readUpgradeIntent();
  if (upgrade.state === 'applying' && upgrade.targetSha !== null && upgrade.requestedAt !== null)
    out.push({ kind: 'upgrade', ref: upgrade.targetSha, at: upgrade.requestedAt });

  return out;
}

const ALL = 100_000;
