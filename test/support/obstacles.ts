import { ObstacleDesk } from '../../src/obstacles/desk.js';
import type { Store } from '../../src/store/store.js';

type Deps = ConstructorParameters<typeof ObstacleDesk>[0];

const WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * One desk runs every obstacle stage, so a test exercising one stage still has to satisfy the deps
 * of all five. This fills the ones it is not about: an inert fleet, a dormancy far past any clock a
 * test sets, and no tracker to file against.
 */
export function obstacleDesk(store: Store, over: Partial<Deps> = {}): ObstacleDesk {
  return new ObstacleDesk({
    store,
    fleet: { isLive: () => false, notify: () => false },
    dormantMs: WEEK,
    watchLabel: '',
    ...over,
  });
}
