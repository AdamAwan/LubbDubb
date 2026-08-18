import type { ErrorRecorder } from './errorLog.js';
import type { ActionSink } from './sink/actionSink.js';
import type { Store } from './store/store.js';
import type { WorldSnapshot } from './types.js';
import { prsToSeedWatch, type PrWatchSeed } from './prWatch.js';

interface PrWatchDeskDeps {
  sink: ActionSink;
  store: Store;
  /** `${labelPrefix}-watch`. Empty = the gate is off and the desk does nothing. */
  watchLabel: string;
  /** The retired `${labelPrefix}-ignore` tag — see {@link PrWatchContext.legacyIgnoreLabel}. */
  legacyIgnoreLabel: string;
  errors?: ErrorRecorder;
}

/**
 * Tags the pull requests the harness opened, so its own work is watched without an
 * operator having to notice it.
 *
 * A desk beside {@link PrNamingDesk} and {@link BranchReapDesk} rather than an
 * action through the executor, for their reason: nothing here is deciding *whether*
 * to work a pull request, only recording that the fleet is the one that opened it.
 * So it is deliberately not auto-send gated, and a failure is recorded rather than
 * failing the cycle — the next pulse retries, because no seed row was written.
 *
 * It is the floor under {@link seedPrWatch}, not a duplicate of it: the tool channel
 * tags a pull request the moment `open_pr` creates it, and this catches every other
 * way one appears on a harness branch — an agent that opened its own after the tool
 * reported itself unwired, a code job's, and every pull request already open on the
 * pulse a deployment first runs this.
 */
export class PrWatchDesk {
  constructor(private readonly deps: PrWatchDeskDeps) {}

  async run(world: WorldSnapshot): Promise<void> {
    const wanted = prsToSeedWatch(world.pullRequests, {
      watchLabel: this.deps.watchLabel,
      legacyIgnoreLabel: this.deps.legacyIgnoreLabel,
      seeded: this.deps.store.seededPrs(),
    });
    for (const seed of wanted) await seedPrWatch(seed, this.deps);
  }
}

/**
 * Write the watch tag onto one pull request the harness opened, and record that it
 * has been written.
 *
 * The one write path, shared by the desk above and by `open_pr` — two callers that
 * would otherwise each have their own idea of what "the harness tags its own pull
 * request" means, and only one of them would be updated when it changed. The seed
 * row goes down **after** the label write, so a failure leaves the pull request for
 * the next pulse rather than marking it done.
 */
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
  deps.store.recordPrWatchSeed(seed.prNumber, seed.branch);
}
