import type { Store } from './store/store.js';
import type { Agent, TaskSummary } from './types.js';
import { burnPass, type BurnPolicy } from './spendBurn.js';

/** The pulse's own reads, handed in — see {@link SpendBurnDesk.run}. */
interface BurnWorld {
  agents: readonly Agent[];
  tasks: readonly TaskSummary[];
}

/**
 * Where a run that is spending far past its kind of work is surfaced, once a
 * pulse.
 *
 * The desk half of {@link burnPass}, and thin for {@link DeliveryCloseOutDesk}'s
 * reason: every decision is in the pure function and this is the store round trip
 * around it. It writes `human_tasks` rows and nothing else — it dispatches
 * nobody, kills nobody, and the dispatcher does not read what it writes.
 */
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
      existing: this.store.listHumanTasksOfKind('burn'),
    });
    for (const step of steps) {
      if (step.kind === 'file')
        this.store.recordHumanTask({
          title: step.title,
          detail: step.detail,
          originRef: step.originRef,
          kind: 'burn',
          agentId: step.agentId,
          taskId: null,
        });
      else this.store.settleHumanTask(step.taskId, step.status, step.resolution);
    }
  }
}
