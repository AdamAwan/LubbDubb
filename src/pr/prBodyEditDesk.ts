import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { descriptionInBody, descriptionRefusal, normaliseBody } from './prDescription.js';

// → docs/spec/07-pull-requests.md#a-description-written-on-the-provider-is-adopted

interface PrBodyReader {
  readPullBody(prNumber: number): Promise<string | null>;
}

interface PrBodyEditDeskDeps {
  bodies: PrBodyReader;
  store: Store;
  errors?: ErrorRecorder;
}

/**
 * Adopts a description somebody wrote straight onto the pull request as a version of
 * the part's, so it is checked like one written in the cockpit and pushed back by
 * `PrDescriptionDesk` with the human mark.
 */
export class PrBodyEditDesk {
  constructor(private readonly deps: PrBodyEditDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const { bodies, store, errors } = this.deps;
    const open = new Set(world.pullRequests.filter((p) => !p.merged && p.state !== 'closed').map((p) => p.number));
    for (const part of store.prDescriptions.bodiesOnRecord()) {
      if (part.pending || !open.has(part.prNumber)) continue;
      let live: string | null;
      try {
        live = await bodies.readPullBody(part.prNumber);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `reading the body of PR ${part.prNumber} failed: ${(err as Error).message}`,
        });
        continue;
      }
      if (live === null) return;
      const text = descriptionInBody(live, part.tail);
      if (text === null || normaliseBody(text) === normaliseBody(part.standing)) continue;
      if (descriptionRefusal(text) !== null) continue;
      store.prDescriptions.appendDescription({ originRef: part.originRef, text, author: null });
    }
  }
}
