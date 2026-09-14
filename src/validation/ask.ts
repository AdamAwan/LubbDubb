import type { Store } from '../store/store.js';

// → docs/spec/20-validation.md

const WITHDRAWN_RESOURCE_RESOLUTION = 'The validation plan no longer needs this.';

const PRECONDITION_KIND = 'access';

export function fileResourceAsks(store: Store, originRef: string): void {
  for (const resource of store.validation.listValidationResources(originRef)) {
    if (resource.provided || resource.kind === PRECONDITION_KIND) continue;
    const { task } = store.humanTasks.recordHumanTask({
      title: `Provide "${resource.name}" for validating ${originRef}`,
      detail: resourceAskDetail(resource.name, resource.note),
      originRef,
      agentId: null,
      taskId: null,
    });
    store.validation.linkValidationResourceTask(originRef, resource.name, task.id);
  }
}

export function withdrawResourceAsks(store: Store, originRef: string, stillNeeded: readonly string[]): void {
  const needed = new Set(stillNeeded);
  for (const resource of store.validation.listValidationResources(originRef)) {
    if (resource.humanTaskId === null || needed.has(resource.name)) continue;
    const task = store.humanTasks.getHumanTask(resource.humanTaskId);
    if (task?.status === 'open') store.humanTasks.settleHumanTask(task.id, 'declined', WITHDRAWN_RESOURCE_RESOLUTION);
  }
}

function resourceAskDetail(name: string, note: string | null): string {
  return [
    `The validation plan needs **${name}**, and the agent that declared it could not produce it.`,
    ...(note === null ? [] : ['', note]),
    '',
    'Put it where the harness keeps validation resources for this goal, then mark this done. Nothing is blocked by it — the checks that use it simply cannot be run yet.',
  ].join('\n');
}
