import { openedGoals } from '../environments/arrival.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { Store } from '../store/store.js';
import type { Issue } from '../types.js';
import { goalValidation, type GoalValidation } from '../validation/goal.js';
import { closeOutPass } from './closeOut.js';

/** The world a close-out pass is judged against — the pulse's own snapshot. */
interface CloseOutWorld {
  issues: Issue[];
}

/**
 * Where the "close the ticket" obligation is filed and settled, once a pulse.
 *
 * The desk half of {@link closeOutPass}, and thin for {@link StackLandingDesk}'s
 * reason: every decision is in the pure function, and this is the store round
 * trip around it. It writes `human_tasks` rows and nothing else — it dispatches
 * nobody, touches no sink, and the dispatcher does not read what it writes.
 */
export class DeliveryCloseOutDesk {
  /**
   * `environments` is read for one thing only: which of them declare that
   * arriving there is what opens the close-out. Passed rather than looked up so
   * this desk and {@link ValidationReadyDesk} cannot form different opinions
   * about a gate the operator wrote once.
   */
  constructor(
    private readonly store: Store,
    private readonly environments: EnvironmentConfig[] = [],
  ) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(world: CloseOutWorld): void {
    const deliveries = this.store.listDeliveries();
    // A pass with nothing standing reads nothing. Every deployment until an issue
    // is assessed is that case, and the sweep runs on every pulse.
    if (deliveries.length === 0) return;
    const steps = closeOutPass({
      issues: world.issues,
      deliveries,
      shortfalls: this.store.listShortfalls(),
      existing: this.store.listHumanTasksOfKind('close_out'),
      validation: this.validationByOrigin(),
      // The bench's own state, not the verdict's: an operator who marked the
      // validate row done is finished with it whatever the checks say.
      validating: new Set(
        this.store
          .listHumanTasksOfKind('validate')
          .filter((t) => t.status === 'open' && t.originRef !== null)
          .map((t) => t.originRef!),
      ),
      opened: openedGoals(
        'close_out',
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
          kind: 'close_out',
          agentId: null,
          taskId: null,
        });
      else this.store.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }

  /**
   * Each planned goal's validation verdict, keyed on the issue origin the
   * close-out pass works in.
   *
   * Through the plan rather than against the origin directly because a plan *is*
   * the per-goal record the checks hang off — the same join the snapshot makes,
   * so the chip on the goal row and the sentence on the obligation cannot
   * disagree about what a goal owes.
   */
  private validationByOrigin(): Map<string, GoalValidation> {
    const out = new Map<string, GoalValidation>();
    for (const plan of this.store.listPlans()) {
      const validation = goalValidation(this.store, plan.originRef);
      if (validation) out.set(plan.originRef, validation);
    }
    return out;
  }
}
