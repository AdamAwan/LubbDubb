import { openedGoals } from '../environments/arrival.js';
import { watchClearedGoals } from '../environments/watchFinding.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import type { Store } from '../store/store.js';
import type { Issue, RemoteSheetRow, ValidationCheck } from '../types.js';
import { checkSetReleased } from './planApproval.js';
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
    const deliveries = this.store.verdicts.listDeliveries();
    const existing = this.store.humanTasks.listHumanTasksOfKind('validate');
    if (deliveries.length === 0 && existing.length === 0) return;
    const checks = this.checksByOrigin(deliveries.map((d) => d.originRef));
    const steps = validationReadyPass({
      issues: world.issues,
      deliveries,
      shortfalls: this.store.verdicts.listShortfalls(),
      existing,
      checks,
      released: this.releasedOf(checks),
      sheetRows: this.sheetRowsByOrigin(),
      watchCleared: watchClearedGoals(
        'validate',
        this.environments,
        this.store.watches.listWatchWindows(),
        this.store.environments.listEnvironmentGateReleases(),
      ),
      opened: openedGoals(
        'validate',
        this.environments,
        this.store.environments.listGoalArrivals(),
        this.store.environments.listEnvironmentGateReleases(),
      ),
    });
    for (const step of steps) {
      if (step.kind === 'file')
        this.store.humanTasks.recordHumanTask({
          title: step.title,
          detail: step.detail,
          originRef: step.originRef,
          kind: 'validate',
          agentId: null,
          taskId: null,
        });
      else if (step.kind === 'reopen') this.store.humanTasks.reopenHumanTask(step.taskId, step.detail);
      else this.store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }

  /**
   * Settle this goal's open `validate` row at the press that answered its last check, rather than at
   * the next pulse.
   *
   * The pulse arm below already settles it — but between the reading and the tick the operator is
   * looking straight at the ask they have just finished, which reads as a row that ignores its own
   * answers. The rule is the pass's, not a second copy of it: the same
   * {@link validationReadyPass} over this one goal, and only its `settle` arm is applied — filing
   * and reopening stay with the pulse, which is the arm that has the world to word a row from.
   *
   * @public called by the validation routes on every recorded reading, and by nothing else
   */
  settleAnswered(originRef: string): boolean {
    const open = this.store.humanTasks.listHumanTasksOfKind('validate').filter((task) => task.originRef === originRef);
    if (!open.some((task) => task.status === 'open')) return false;
    const delivery = this.store.verdicts.listDeliveries().find((d) => d.originRef === originRef);
    if (delivery === undefined) return false;
    const steps = validationReadyPass({
      issues: [],
      deliveries: [delivery],
      shortfalls: this.store.verdicts.listShortfalls(),
      existing: open,
      checks: this.checksByOrigin([originRef]),
      sheetRows: this.sheetRowsByOrigin(),
      opened: null,
      released: null,
      watchCleared: null,
    });
    let settled = false;
    for (const step of steps) {
      if (step.kind !== 'settle') continue;
      this.store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
      settled = true;
    }
    return settled;
  }

  private releasedOf(checks: ReadonlyMap<string, readonly ValidationCheck[]>): Set<string> {
    const out = new Set<string>();
    for (const [originRef, its] of checks)
      if (checkSetReleased({ record: this.store.validation.getValidationPlanRecord(originRef), checks: its }))
        out.add(originRef);
    return out;
  }

  private sheetRowsByOrigin(): Map<string, RemoteSheetRow[]> {
    const out = new Map<string, RemoteSheetRow[]>();
    if (!this.environments.some((e) => e.validate !== undefined)) return out;
    for (const row of this.store.remoteValidation.listRemoteSheetRows()) {
      const held = out.get(row.goalRef);
      if (held === undefined) out.set(row.goalRef, [row]);
      else held.push(row);
    }
    return out;
  }

  private checksByOrigin(origins: readonly string[]): Map<string, ValidationCheck[]> {
    const out = new Map<string, ValidationCheck[]>();
    for (const originRef of origins) out.set(originRef, this.store.validation.listValidationChecks(originRef));
    return out;
  }
}
