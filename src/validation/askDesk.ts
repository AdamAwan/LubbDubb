import type { Store } from '../store/store.js';
import { fileResourceAsks } from './ask.js';

// → docs/spec/20-validation.md

export class ValidationAskDesk {
  constructor(private readonly store: Store) {}

  /** @public called by `Harness.runCycle`, beside the other bookkeeping passes. */
  run(): void {
    const deliveries = this.store.verdicts.listDeliveries();
    if (deliveries.length === 0) return;
    const shortfalls = new Set(this.store.verdicts.listShortfalls().map((s) => s.originRef));
    for (const delivery of deliveries) {
      if (shortfalls.has(delivery.originRef)) continue;
      fileResourceAsks(this.store, delivery.originRef);
    }
  }
}
