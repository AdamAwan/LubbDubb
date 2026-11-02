import type { ErrorRecorder } from '../errorLog.js';
import type { ActionSink } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { prState } from './prHealth.js';

// → docs/spec/07-pull-requests.md#the-operator-writes-the-description

interface PrDescriptionDeskDeps {
  sink: ActionSink;
  store: Store;
  errors?: ErrorRecorder;
}

/**
 * Puts a written description onto the pull request it describes.
 *
 * The description is written after the pull request opens — a person cannot say what
 * a change does before they have read it — so this is the only path by which one ever
 * reaches a reviewer. A version that is written and never pushed is the quiet failure
 * the feature exists to remove, one surface along: the cockpit would show a described
 * part and the reviewer would meet a body with nothing above the evidence.
 *
 * A push that throws leaves `pushed_at` null, so the next pulse tries again. That is
 * why the stamp is written after the send and not before it.
 */
export class PrDescriptionDesk {
  constructor(private readonly deps: PrDescriptionDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const { sink, store, errors } = this.deps;
    const closed = closedPullRequests(world);
    for (const pending of store.prDescriptions.unpushedDescriptions()) {
      if (closed.has(pending.prNumber)) {
        store.prDescriptions.markPrClosed(pending.id);
        continue;
      }
      try {
        await sink.setPullBody({ prNumber: pending.prNumber, body: pending.body });
        store.prDescriptions.markPushed(pending.id);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `writing the description onto PR ${pending.prNumber} failed: ${(err as Error).message}`,
        });
      }
    }
    for (const pending of store.prDescriptions.unpushedDrafts()) {
      if (closed.has(pending.prNumber)) {
        store.prDescriptions.markDraftPrClosed(pending.originRef);
        continue;
      }
      try {
        await sink.setPullBody({ prNumber: pending.prNumber, body: pending.body });
        store.prDescriptions.markDraftPushed(pending.originRef);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `writing the agent's description onto PR ${pending.prNumber} failed: ${(err as Error).message}`,
        });
      }
    }
  }
}

function closedPullRequests(world: WorldSnapshot): Set<number> {
  const closed = new Set((world.closedPullRequests ?? []).map((pr) => pr.number));
  for (const pr of world.pullRequests) {
    if (prState(pr) !== 'open') closed.add(pr.number);
    else closed.delete(pr.number);
  }
  return closed;
}
