import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { descriptionInBody, descriptionRefusal, normaliseBody } from './prDescription.js';

// → docs/spec/07-pull-requests.md#a-description-written-on-the-provider-is-adopted

/**
 * Adopts a description somebody wrote straight onto the pull request as a version of
 * the part's, so it is checked like one written in the cockpit and pushed back by
 * `PrDescriptionDesk` with the human mark.
 */
export class PrBodyEditDesk {
  constructor(private readonly deps: { store: Store }) {}

  run(world: WorldSnapshot): void {
    const { store } = this.deps;
    if ((world.staleSources ?? []).length > 0) return;
    const bodies = new Map<number, string>();
    for (const pr of world.pullRequests) if (!pr.merged && pr.body !== undefined) bodies.set(pr.number, pr.body);
    const owed = new Set([
      ...store.prDescriptions.unpushedDescriptions().map((p) => p.prNumber),
      ...store.prDescriptions.unpushedDrafts().map((p) => p.prNumber),
    ]);
    for (const part of store.prDescriptions.bodiesOnRecord([...bodies.keys()])) {
      if (owed.has(part.prNumber)) continue;
      const text = descriptionInBody(bodies.get(part.prNumber)!, part.tail);
      if (text === null || normaliseBody(text) === normaliseBody(part.standing)) continue;
      if (descriptionRefusal(text) !== null) continue;
      store.prDescriptions.appendDescription({ originRef: part.originRef, text, author: null });
    }
  }
}
