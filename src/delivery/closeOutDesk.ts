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
    /**
     * The goals owing the second scoring moment, as origin refs. A closure rather
     * than a store member because the record it reads is not on `Store` and must not
     * become reachable from one; refs rather than rows because nothing this desk
     * writes may carry what the operator wrote. Empty when the gate is off, which is
     * also what settles any row left standing when it is turned off.
     */
    private readonly outcomeOwed: () => ReadonlySet<string> = () => new Set(),
  ) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(world: CloseOutWorld): void {
    const deliveries = this.store.verdicts.listDeliveries();
    const existing = this.store.humanTasks.listHumanTasksOfKind('close_out');
    const existingOutcome = this.store.humanTasks.listHumanTasksOfKind('outcome');
    if (deliveries.length === 0 && existing.length === 0 && existingOutcome.length === 0) return;
    const readings = watchWindowReadings({
      windows: this.store.watches.listWatchWindows(),
      checks: this.store.watches.listGoalWatches(),
      readings: this.store.watches.listWatchReadings(),
    });
    const steps = closeOutPass({
      issues: world.issues,
      deliveries,
      shortfalls: this.store.verdicts.listShortfalls(),
      existing,
      validation: this.validationByOrigin(),
      validating: new Set(
        this.store.humanTasks
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
        this.store.watches.listWatchWindows(),
        this.store.environments.listEnvironmentGateReleases(),
      ),
      canClose: this.canClose(),
      outcomeOwed: this.outcomeOwed(),
      existingOutcome,
      opened: openedGoals(
        'close_out',
        this.environments,
        this.store.environments.listGoalArrivals(),
        this.store.environments.listEnvironmentGateReleases(),
      ),
    });
    for (const step of steps) {
      if (step.kind === 'file' || step.kind === 'file-outcome')
        this.store.humanTasks.recordHumanTask({
          title: step.title,
          detail: step.detail,
          originRef: step.originRef,
          kind: step.kind === 'file' ? 'close_out' : 'outcome',
          agentId: null,
          taskId: null,
        });
      else if (step.kind === 'reopen') this.store.humanTasks.reopenHumanTask(step.taskId, step.detail);
      else this.store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }

  private validationByOrigin(): Map<string, GoalValidation> {
    const out = new Map<string, GoalValidation>();
    for (const plan of this.store.plans.listPlans()) {
      const validation = goalValidation(this.store, plan.originRef);
      if (validation) out.set(plan.originRef, validation);
    }
    return out;
  }
}
