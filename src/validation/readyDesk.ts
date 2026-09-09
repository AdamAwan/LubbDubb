import { openedGoals } from '../environments/arrival.js';
import { watchClearedGoals } from '../environments/watchFinding.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { Store } from '../store/store.js';
import type { Issue, RemoteSheetRow, ValidationCheck } from '../types.js';
import { validationReadyPass } from './ready.js';

// → docs/spec/20-validation.md

interface ValidationReadyWorld {
  issues: Issue[];
}

export class ValidationReadyDesk {
  constructor(
    private readonly store: Store,
    private readonly environments: EnvironmentConfig[] = [],
  ) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(world: ValidationReadyWorld): void {
    const deliveries = this.store.listDeliveries();
    const existing = this.store.listHumanTasksOfKind('validate');
    if (deliveries.length === 0 && existing.length === 0) return;
    const steps = validationReadyPass({
      issues: world.issues,
      deliveries,
      shortfalls: this.store.listShortfalls(),
      existing,
      checks: this.checksByOrigin(deliveries.map((d) => d.originRef)),
      sheetRows: this.sheetRowsByOrigin(),
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

  private sheetRowsByOrigin(): Map<string, RemoteSheetRow[]> {
    const out = new Map<string, RemoteSheetRow[]>();
    if (!this.environments.some((e) => e.validate !== undefined)) return out;
    for (const row of this.store.listRemoteSheetRows()) {
      const held = out.get(row.goalRef);
      if (held === undefined) out.set(row.goalRef, [row]);
      else held.push(row);
    }
    return out;
  }

  private checksByOrigin(origins: readonly string[]): Map<string, ValidationCheck[]> {
    const out = new Map<string, ValidationCheck[]>();
    for (const originRef of origins) out.set(originRef, this.store.listValidationChecks(originRef));
    return out;
  }
}
