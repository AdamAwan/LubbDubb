import { openedGoals } from '../environments/arrival.js';
import { watchClearedGoals } from '../environments/watchFinding.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { Store } from '../store/store.js';
import type { Issue, ValidationCheck } from '../types.js';
import { validationReadyPass } from './ready.js';

/** The world a validate pass is judged against — the pulse's own snapshot. */
interface ValidationReadyWorld {
  issues: Issue[];
}

/**
 * Where "this goal is ready to be validated" becomes a bench row, once a pulse.
 *
 * The desk half of {@link validationReadyPass}, and thin for
 * {@link DeliveryCloseOutDesk}'s reason: every decision is in the pure function,
 * and this is the store round trip around it. It writes `human_tasks` rows and
 * nothing else — it dispatches nobody, touches no sink, and the dispatcher does
 * not read what it writes.
 *
 * Beside {@link ValidationAskDesk} and against the same gate: a check runs
 * against the delivered goal, so the delivery is the first pulse on which asking
 * anybody to run one means anything. Kept a desk of its own rather than folded
 * into the ask desk because the two settle differently — a resource ask waits on
 * a person handing something over, and this one is discharged by rows the harness
 * can read for itself.
 */
export class ValidationReadyDesk {
  /**
   * `environments` is read for one thing only: which of them declare that
   * arriving there is what opens the checks. Passed rather than looked up so this
   * desk and {@link DeliveryCloseOutDesk} cannot form different opinions about a
   * gate the operator wrote once.
   */
  constructor(
    private readonly store: Store,
    private readonly environments: EnvironmentConfig[] = [],
  ) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(world: ValidationReadyWorld): void {
    const deliveries = this.store.listDeliveries();
    const existing = this.store.listHumanTasksOfKind('validate');
    // A pass with nothing delivered *and* nothing standing reads nothing further.
    // Every deployment until an issue is assessed is that case, and the sweep runs
    // on every pulse. Both halves are load-bearing: the retraction arm reads the
    // standing rows, so it is the one arm with work to do precisely when nothing
    // is delivered — clearing the last delivery is exactly that state.
    if (deliveries.length === 0 && existing.length === 0) return;
    const steps = validationReadyPass({
      issues: world.issues,
      deliveries,
      shortfalls: this.store.listShortfalls(),
      existing,
      checks: this.checksByOrigin(deliveries.map((d) => d.originRef)),
      watchCleared: watchClearedGoals(
        'validate',
        this.environments,
        this.store.listWatchWindows(),
        this.store.listEnvironmentGateReleases(),
      ),
      opened: openedGoals(
        'validate',
        this.environments,
        this.store.listGoalArrivals(),
        this.store.listEnvironmentGateReleases(),
      ),
    });
    for (const step of steps) {
      if (step.kind === 'file')
        this.store.recordHumanTask({
          title: step.title,
          detail: step.detail,
          originRef: step.originRef,
          kind: 'validate',
          agentId: null,
          taskId: null,
        });
      else if (step.kind === 'reopen') this.store.reopenHumanTask(step.taskId, step.detail);
      else this.store.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }

  /**
   * The checks of each delivered goal, read straight off the goal.
   *
   * Per delivery rather than per plan: the checks are keyed on the goal
   * ([20](../../docs/spec/20-validation.md)), and a goal whose plan was replaced
   * still owes the results its checks were recorded under.
   */
  private checksByOrigin(origins: readonly string[]): Map<string, ValidationCheck[]> {
    const out = new Map<string, ValidationCheck[]>();
    for (const originRef of origins) out.set(originRef, this.store.listValidationChecks(originRef));
    return out;
  }
}
