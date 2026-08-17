import type { Store } from '../store/store.js';
import { fileResourceAsks } from './ask.js';

/**
 * Where a validation plan's unmet resources become bench rows, once a pulse.
 *
 * The delivery gate lives here rather than in {@link fileResourceAsks}, on
 * `DeliveryCloseOutDesk`'s pattern and beside it in the cycle: the decision about
 * *which* goals owe an ask is one read of the verdict tables, and the filing is
 * the store round trip around it. It writes `human_tasks` rows and nothing else —
 * it dispatches nobody, touches no sink, and the dispatcher does not read what it
 * writes.
 *
 * **Only a goal parked as delivered.** A resource is what makes a check runnable,
 * and a check runs against the delivered goal — rule `validate-check` refuses to
 * dispatch before then and the cockpit offers nothing either, so an ask filed
 * earlier is a question a person cannot answer usefully about work that may still
 * change under it. A **shortfall** is excluded for the reason the close-out sweep
 * excludes it: the assessor sent the goal back, so there is nothing delivered to
 * validate.
 */
export class ValidationAskDesk {
  constructor(private readonly store: Store) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(): void {
    const deliveries = this.store.listDeliveries();
    // A pass with nothing delivered reads nothing further. Every deployment until
    // an issue is assessed is that case, and the sweep runs on every pulse.
    if (deliveries.length === 0) return;
    const shortfalls = new Set(this.store.listShortfalls().map((s) => s.originRef));
    for (const delivery of deliveries) {
      if (shortfalls.has(delivery.originRef)) continue;
      fileResourceAsks(this.store, delivery.originRef);
    }
  }
}
