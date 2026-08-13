import type { Store } from '../store/store.js';

/**
 * File the bench row for every resource a plan's validation block says it needs
 * and cannot produce — a seeded fixture, a reference screenshot, an account on an
 * environment.
 *
 * Shared by the two writers of a validation block (`ingestPlanDocument` and the
 * `validation_amend` tool) rather than copied into each, because the interesting
 * behaviour is idempotence and a second copy is where idempotence goes to die:
 * `recordHumanTask` refreshes on a repeat rather than inserting, so a replan
 * re-declaring the same resource does not file the ask twice — and one
 * re-declaring a resource the operator already settled leaves that settlement
 * standing, the same discipline `upsertPlanParts` applies to a part's progress.
 *
 * **Nothing here blocks anything.** A missing resource is an ask, so that a check
 * which cannot be run yet is a stated fact rather than one that mysteriously
 * never runs.
 */
export function fileResourceAsks(store: Store, planId: string, originRef: string): void {
  for (const resource of store.listValidationResources(planId)) {
    if (resource.provided) continue;
    const { task } = store.recordHumanTask({
      title: `Provide "${resource.name}" for validating ${originRef}`,
      detail: resourceAskDetail(resource.name, resource.note),
      originRef,
      agentId: null,
      taskId: null,
    });
    store.linkValidationResourceTask(planId, resource.name, task.id);
  }
}

/**
 * What the ask says. The author's own note when they left one — it is the only
 * thing that says *which* fixture or *whose* account — and never empty, because a
 * bench row reading only "provide it" is a row nobody can act on.
 */
function resourceAskDetail(name: string, note: string | null): string {
  return [
    `The validation plan needs **${name}**, and the agent that declared it could not produce it.`,
    ...(note === null ? [] : ['', note]),
    '',
    'Put it where the harness keeps validation resources for this goal, then mark this done. Nothing is blocked by it — the checks that use it simply cannot be run yet.',
  ].join('\n');
}
