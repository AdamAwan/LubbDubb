import type { Store } from '../../store/store.js';
import type { CalendarEvent, Issue, PullRequest } from '../../types.js';

const STATE_KEY = 'fake_world';

/** The editable, persisted document the fake integrations share. */
export interface FakeWorld {
  pullRequests: PullRequest[];
  issues: Issue[];
  calendar: CalendarEvent[];
}

export const EMPTY_WORLD: FakeWorld = { pullRequests: [], issues: [], calendar: [] };

/**
 * A thin read/write wrapper over the single persisted `fake_world` document in
 * the store. All three fake integrations share ONE instance, so the world they
 * present is coherent and survives a restart — exactly as the old monolithic
 * `FakeConnector` behaved, now factored out so each domain lives in its own
 * module. `better-sqlite3` is synchronous, so shared reads/writes are race-free.
 */
export class FakeWorldStore {
  constructor(private readonly store: Store) {}

  read(): FakeWorld {
    const raw = this.store.getConnectorState(STATE_KEY);
    if (!raw) return clone(EMPTY_WORLD);
    // Backfill any domain a world persisted before that domain existed lacks, so
    // a schema-additive change (e.g. adding `issues`) never trips on `undefined`.
    return { ...clone(EMPTY_WORLD), ...(JSON.parse(raw) as Partial<FakeWorld>) };
  }

  write(world: FakeWorld): void {
    this.store.setConnectorState(STATE_KEY, JSON.stringify(world));
  }

  /** Read → mutate in place → write back, in one call. */
  mutate(fn: (world: FakeWorld) => void): void {
    const world = this.read();
    fn(world);
    this.write(world);
  }
}

export function clone(world: FakeWorld): FakeWorld {
  return JSON.parse(JSON.stringify(world)) as FakeWorld;
}
