import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import type { WorldSnapshot } from './types.js';
import { prsToSeedWatch, type PrWatchSeed } from './prWatch.js';

// → docs/spec/07-pull-requests.md

interface PrWatchDeskDeps {
  sink: ActionSink;
  store: Store;
  watchLabel: string;
  legacyIgnoreLabel: string;
  errors?: ErrorRecorder;
}

export class PrWatchDesk {
  constructor(private readonly deps: PrWatchDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const wanted = prsToSeedWatch(world.pullRequests, {
      watchLabel: this.deps.watchLabel,
      legacyIgnoreLabel: this.deps.legacyIgnoreLabel,
      seeded: this.deps.store.prWatchSeeds.seededPrs(),
    });
    for (const seed of wanted) await seedPrWatch(seed, this.deps);
  }
}

export async function seedPrWatch(
  seed: PrWatchSeed,
  deps: { sink: ActionSink; store: Store; watchLabel: string; errors?: ErrorRecorder },
): Promise<void> {
  if (!deps.watchLabel) return;
  try {
    await deps.sink.setPrLabel({ prNumber: seed.prNumber, label: deps.watchLabel, present: true });
  } catch (err) {
    deps.errors?.record({
      source: 'cycle',
      message: `tagging PR ${seed.prNumber} "${deps.watchLabel}" failed: ${(err as Error).message}`,
    });
    return;
  }
  deps.store.prWatchSeeds.recordPrWatchSeed(seed.prNumber, seed.branch);
}
