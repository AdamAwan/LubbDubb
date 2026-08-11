import type { Store } from '../store/store.js';
import type { Issue } from '../types.js';
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
  constructor(private readonly store: Store) {}

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
}
