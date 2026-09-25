import type { Store } from '../store/store.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { ValidatedAction } from '../dispatcher/actions.js';
import type { RecordOutcome } from './proposalActs.js';

// → docs/spec/09-execution.md

interface ProviderDeps {
  store: Store;
  sink: ActionSink;
  errors: ErrorRecorder;
}

export async function updatePrBranch(
  deps: ProviderDeps,
  action: ValidatedAction & { type: 'update_pr_branch' },
  record: RecordOutcome,
): Promise<void> {
  const { store } = deps;
  const ejected = store.ejections.ejectionOnBranch(action.branch);
  if (ejected) {
    record(
      'deferred',
      `Deferred: branch ${action.branch} is held by an ejection (${ejected.id}); merging ` +
        `${action.base} in under an operator's own checkout would move it beneath them. ` +
        'Will retry when they hand it back.',
    );
    return;
  }
  const staffed = store.tasks.findActiveTaskByBranch(action.branch);
  if (staffed) {
    record(
      'deferred',
      `Deferred: branch ${action.branch} is held by active task ${staffed.id}; ` +
        `merging ${action.base} in under it would move the commit its worktree was cut from. ` +
        `Will retry when it frees.`,
    );
    return;
  }
  try {
    const res = await deps.sink.updatePrBranch({ prNumber: action.prNumber, base: action.base });
    if (!res.ok) {
      record(
        'skipped',
        `This provider cannot merge ${action.base} into PR #${action.prNumber} itself; ` +
          `a code agent will be dispatched to do it.`,
      );
      return;
    }
    record(
      'executed',
      `Brought PR #${action.prNumber} up to date with ${action.base} — no agent spent.${res.ref ? ` ref=${res.ref}` : ''}`,
    );
  } catch (err) {
    const message = (err as Error).message;
    deps.errors.record({
      source: 'provider',
      message: `Updating PR #${action.prNumber} from ${action.base} failed: ${message}`,
      detail: 'Rule pr-base-update will dispatch a code agent to merge the base in instead.',
    });
    record(
      'rejected',
      `Failed to merge ${action.base} into PR #${action.prNumber}: ${message}. ` +
        `A code agent will be dispatched to do it.`,
    );
  }
}

export async function requeueCiCheck(
  deps: ProviderDeps,
  action: ValidatedAction & { type: 'requeue_ci_check' },
  record: RecordOutcome,
): Promise<void> {
  const unperformed: string[] = [];
  try {
    for (const check of action.checks) {
      const res = await deps.sink.requeueCiCheck({
        prNumber: action.prNumber,
        check: check.name,
        requeueRef: check.requeueRef,
      });
      if (!res.ok) unperformed.push(check.name);
    }
  } catch (err) {
    const message = (err as Error).message;
    deps.errors.record({
      source: 'provider',
      message: `Requeueing the expired check(s) on PR #${action.prNumber} failed: ${message}`,
      detail: 'Rule pr-ci-gate will dispatch a code agent to queue the build instead.',
    });
    record(
      'rejected',
      `Failed to requeue the expired check(s) on PR #${action.prNumber}: ${message}. ` +
        `A code agent will be dispatched to queue the build.`,
    );
    return;
  }
  if (unperformed.length > 0) {
    record(
      'skipped',
      `This provider did not requeue ${unperformed.join(', ')} on PR #${action.prNumber}; ` +
        `a code agent will be dispatched to queue the build.`,
    );
    return;
  }
  record(
    'executed',
    `Queued a fresh run of ${action.checks.map((c) => c.name).join(', ')} on PR #${action.prNumber} — no agent spent.`,
  );
}

export async function setWorkItemState(
  deps: ProviderDeps,
  action: ValidatedAction & { type: 'set_work_item_state' },
  record: RecordOutcome,
): Promise<void> {
  try {
    const res = await deps.sink.setWorkItemState({ number: action.number, state: action.state });
    record('executed', `Set work item #${action.number} to "${action.state}".${res.ref ? ` ref=${res.ref}` : ''}`);
  } catch (err) {
    record('rejected', `Failed to set work item #${action.number} state: ${(err as Error).message}`);
  }
}
