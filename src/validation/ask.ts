import type { Store } from '../store/store.js';

/**
 * What the ask says when the plan that filed it stopped needing the resource.
 *
 * Declined rather than deleted or marked done, the settlement `ingestPlanDocument`
 * already gives the human part an amended plan dropped: the row stays as the
 * record of what was asked for, and the note is the account of why it stopped
 * being owed. Marking it done would claim the operator produced something nobody
 * ever handed over.
 */
const WITHDRAWN_RESOURCE_RESOLUTION = 'The validation plan no longer needs this.';

/**
 * File the bench row for every resource a **delivered** goal's validation block
 * says it needs and cannot produce — a seeded fixture, a reference screenshot, an
 * account on an environment.
 *
 * **Filed against the delivery, not against the plan.** A resource exists to make
 * a check runnable, and a check is executed against the delivered goal — rule
 * `validate-check` will not dispatch one before then, and nothing else offers to
 * run one either. Filed at ingestion instead, the ask lands the moment a planner
 * submits: on a plan still `awaiting_approval`, weeks before there is anything to
 * validate, asking a person for a fixture against work that may never be built.
 * That is a row an operator cannot act on and cannot get rid of, sitting in the
 * queue beside the ones they can, which is the whole cost of putting it there
 * early — the ask is not more useful for being older.
 *
 * Called once a pulse by {@link ValidationAskDesk} rather than by either writer of
 * a validation block, which is also what makes idempotence cheap:
 * `recordHumanTask` refreshes on a repeat rather than inserting, so a pulse over a
 * goal it has already asked about writes nothing new — and one re-declaring a
 * resource the operator already settled leaves that settlement standing, the same
 * discipline `upsertPlanParts` applies to a part's progress.
 *
 * **Nothing here blocks anything.** A missing resource is an ask, so that a check
 * which cannot be run yet is a stated fact rather than one that mysteriously
 * never runs.
 */
export function fileResourceAsks(store: Store, originRef: string): void {
  for (const resource of store.listValidationResources(originRef)) {
    if (resource.provided) continue;
    const { task } = store.recordHumanTask({
      title: `Provide "${resource.name}" for validating ${originRef}`,
      detail: resourceAskDetail(resource.name, resource.note),
      originRef,
      agentId: null,
      taskId: null,
    });
    store.linkValidationResourceTask(originRef, resource.name, task.id);
  }
}

/**
 * Withdraw the ask for every resource this goal has stopped asking for — one the
 * new declaration dropped, and one it now says is provided after all.
 *
 * The other half of {@link fileResourceAsks}, and the half whose absence is
 * silent: a replan that drops a fixture deletes the resource row (the ingest
 * writer replaces them wholesale) and leaves the bench row behind, pointing at
 * something no plan asks for and with nothing left that could ever settle it. The
 * operator's only way out is to answer an obligation that stopped existing.
 *
 * **Called before the resources are rewritten**, because the ask is reached
 * through the row that is about to be replaced. `stillNeeded` is what the goal
 * will ask for once this write lands, which each caller computes for itself: the
 * two writers disagree about what an omission means, and folding that decision in
 * here would give one of them the other's answer.
 */
export function withdrawResourceAsks(store: Store, originRef: string, stillNeeded: readonly string[]): void {
  const needed = new Set(stillNeeded);
  for (const resource of store.listValidationResources(originRef)) {
    if (resource.humanTaskId === null || needed.has(resource.name)) continue;
    const task = store.getHumanTask(resource.humanTaskId);
    // Open ones only: an answered row is the operator's record of what they did
    // about it, and overwriting their resolution with the harness's is the one
    // thing a withdrawal must not do.
    if (task?.status === 'open') store.settleHumanTask(task.id, 'declined', WITHDRAWN_RESOURCE_RESOLUTION);
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
