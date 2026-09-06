import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import type { WorldSnapshot } from './types.js';
import { prsToLinkWorkItem, type WorkItemLinkSeed } from './prWorkItemLink.js';

// → docs/spec/07-pull-requests.md

interface PrWorkItemDeskDeps {
  sink: ActionSink;
  store: Store;
  prAuthorConfigured: boolean;
  errors?: ErrorRecorder;
}

export class PrWorkItemDesk {
  constructor(private readonly deps: PrWorkItemDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const wanted = prsToLinkWorkItem(world.pullRequests, {
      prAuthorConfigured: this.deps.prAuthorConfigured,
      issues: world.issues,
      linked: this.deps.store.linkedWorkItemPrs(),
    });
    for (const seed of wanted) await linkPrWorkItem(seed, this.deps);
  }
}

export async function linkPrWorkItem(
  seed: WorkItemLinkSeed,
  deps: { sink: ActionSink; store: Store; errors?: ErrorRecorder },
): Promise<void> {
  let result;
  try {
    result = await deps.sink.linkWorkItem({ number: seed.workItemNumber, prNumber: seed.prNumber });
  } catch (err) {
    deps.errors?.record({
      source: 'cycle',
      message:
        `linking PR ${seed.prNumber} to work item #${seed.workItemNumber} failed: ` + `${(err as Error).message}`,
    });
    return;
  }
  if (!result.ok) return;
  deps.store.recordWorkItemLink(seed.prNumber, seed.workItemNumber);
}
