import { openedGoals } from '../environments/arrival.js';
import { watchClearedGoals, watchCloseOutLine, watchWindowReadings } from '../environments/watchFinding.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { Store } from '../store/store.js';
import type { Issue } from '../types.js';
import { goalValidation, type GoalValidation } from '../validation/goal.js';
import { closeOutPass } from './closeOut.js';

// → docs/spec/24-environments.md

interface CloseOutWorld {
  issues: Issue[];
}

export class DeliveryCloseOutDesk {
  constructor(
    private readonly store: Store,
    private readonly environments: EnvironmentConfig[] = [],
    private readonly canClose: () => boolean = () => false,
  ) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(world: CloseOutWorld): void {
    const deliveries = this.store.listDeliveries();
    const existing = this.store.listHumanTasksOfKind('close_out');
    if (deliveries.length === 0 && existing.length === 0) return;
    const readings = watchWindowReadings({
      windows: this.store.listWatchWindows(),
      checks: this.store.listGoalWatches(),
      readings: this.store.listWatchReadings(),
    });
    const steps = closeOutPass({
      issues: world.issues,
      deliveries,
      shortfalls: this.store.listShortfalls(),
      existing,
      validation: this.validationByOrigin(),
      validating: new Set(
        this.store
          .listHumanTasksOfKind('validate')
          .filter((t) => t.status === 'open' && t.originRef !== null)
          .map((t) => t.originRef!),
      ),
      watch: new Map(
        deliveries.flatMap((d) => {
          const said = watchCloseOutLine(d.originRef, readings);
          return said === null ? [] : [[d.originRef, said] as const];
        }),
      ),
      watchCleared: watchClearedGoals(
        'close_out',
        this.environments,
        this.store.listWatchWindows(),
        this.store.listEnvironmentGateReleases(),
      ),
      canClose: this.canClose(),
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
      else if (step.kind === 'reopen') this.store.reopenHumanTask(step.taskId, step.detail);
      else this.store.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }

  private validationByOrigin(): Map<string, GoalValidation> {
    const out = new Map<string, GoalValidation>();
    for (const plan of this.store.listPlans()) {
      const validation = goalValidation(this.store, plan.originRef);
      if (validation) out.set(plan.originRef, validation);
    }
    return out;
  }
}
