import type { Store } from '../store/store.js';
import type { PetActionKind } from '../types.js';

/** One operator action, reduced to what the roll needs. */
interface PetActionCandidate {
  kind: PetActionKind;
  ref: string;
  at: string;
}

/**
 * Where a pet can come from, and the whole of it.
 *
 * One table rather than a call at each settling route, and that is the rule to
 * keep: a source recorded where it happens pays out only while *that* route is
 * the one that settles it, and the day a second path settles the same thing
 * nothing goes red — the actions simply stop counting.
 *
 * Every member is something a **person** did. The fleet's own work is absent on
 * purpose: it funds the beats and cannot earn a creature.
 */
export function collectActions(store: Store): PetActionCandidate[] {
  const out: PetActionCandidate[] = [];

  // An escalation is answered by exactly one person, and `answeredAt` is stamped
  // when they do — the cleanest operator action in the harness.
  for (const escalation of store.listEscalations()) {
    if (escalation.answeredAt !== null) out.push({ kind: 'escalation', ref: escalation.id, at: escalation.answeredAt });
  }

  // `ask` only, and `done` only. A `close_out` task is the harness's own and the
  // harness settles it, so it is not an operator acting; and a declined task is
  // the operator saying the ask should not have been made, which is not work done.
  for (const task of store.listHumanTasks(ALL)) {
    if (task.kind === 'ask' && task.status === 'done' && task.resolvedAt !== null)
      out.push({ kind: 'human-task', ref: task.id, at: task.resolvedAt });
  }

  // A plan leaves `awaiting_approval` when somebody accepts it. `updatedAt` moves
  // afterwards, which costs nothing: an action already rolled is skipped by key.
  for (const plan of store.listPlans()) {
    if (plan.status === 'active' || plan.status === 'complete')
      out.push({ kind: 'plan', ref: plan.id, at: plan.updatedAt });
  }

  // Authorising a chain to land. The row exists only because somebody clicked.
  for (const landing of store.listStackLandings(ALL)) {
    out.push({ kind: 'landing', ref: landing.id, at: landing.createdAt });
  }

  // Operator-launched jobs only. A job carrying an `originRef` stands in for work
  // a crash recovery requeued, which is the harness redoing its own.
  for (const job of store.listJobs(ALL)) {
    if (job.originRef === null) out.push({ kind: 'job', ref: job.id, at: job.createdAt });
  }

  // A finding is filed by an agent and *triaged* by a person: promoted, filed or
  // dismissed. `filing` is the in-flight state of the middle one, so it is not yet
  // a settled act.
  for (const finding of store.listFindings(ALL)) {
    if (finding.status !== 'open' && finding.status !== 'filing')
      out.push({ kind: 'finding', ref: finding.id, at: finding.updatedAt });
  }

  // The operator accepting an upgrade of the harness's own build. Keyed on the
  // target commit rather than the row, which is a single mutable record: one
  // upgrade, one action, however many times the row is rewritten.
  const upgrade = store.readUpgradeIntent();
  if (upgrade.state === 'applying' && upgrade.targetSha !== null && upgrade.requestedAt !== null)
    out.push({ kind: 'upgrade', ref: upgrade.targetSha, at: upgrade.requestedAt });

  return out;
}

/**
 * These tables are hundreds of rows on a long-lived deployment, not millions, and
 * the scan filters by key against what it has already rolled rather than by a
 * watermark — so it reads all of them and lets the set do the work. A limit here
 * would silently stop paying out for anything older than it.
 */
const ALL = 100_000;
