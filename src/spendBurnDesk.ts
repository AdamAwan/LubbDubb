import type { Store } from './store/store.js';
import type { Agent, TaskSummary } from './types.js';
import { burnPass, type BurnPolicy } from './spendBurn.js';

// → docs/spec/18-observability.md

interface BurnWorld {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
}

export class SpendBurnDesk {
  constructor(
    private readonly store: Store,
    private readonly policy: BurnPolicy,
  ) {}

  /**
   * @public called by `Harness.runCycle`, beside the other bookkeeping passes.
   *
   * Handed the cycle's own `agents` and `tasks` rather than reading its own, so
   * the pulse walks those two tables once between the dispatcher and this. It is
   * the same seam the reads were already taken at, and the desk has no use for a
   * fresher one: a turn that reported in the last few milliseconds is next
   * pulse's news either way.
   */
  run(world: BurnWorld): void {
    const steps = burnPass({
      policy: this.policy,
      agents: world.agents,
      tasks: world.tasks,
      existing: this.store.humanTasks.listHumanTasksOfKind('burn'),
    });
    for (const step of steps) {
      if (step.kind === 'file')
        this.store.humanTasks.recordHumanTask({
          title: step.title,
          detail: step.detail,
          originRef: step.originRef,
          kind: 'burn',
          agentId: step.agentId,
          taskId: null,
        });
      else this.store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }
}
