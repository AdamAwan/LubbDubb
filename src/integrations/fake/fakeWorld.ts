import type { Store } from '../../store/store.js';
import type { Issue, PullRequest } from '../../types.js';

// → docs/spec/15-integrations.md

const STATE_KEY = 'fake_world';

export interface FakeWorld {
  pullRequests: PullRequest[];
  closedPullRequests: PullRequest[];
  issues: Issue[];
}

const EMPTY_WORLD: FakeWorld = { pullRequests: [], closedPullRequests: [], issues: [] };

export class FakeWorldStore {
  constructor(private readonly store: Store) {}

  read(): FakeWorld {
    const raw = this.store.getConnectorState(STATE_KEY);
    if (!raw) return clone(EMPTY_WORLD);
    return { ...clone(EMPTY_WORLD), ...(JSON.parse(raw) as Partial<FakeWorld>) };
  }

  write(world: FakeWorld): void {
    this.store.setConnectorState(STATE_KEY, JSON.stringify(world));
  }

  mutate(fn: (world: FakeWorld) => void): void {
    const world = this.read();
    fn(world);
    this.write(world);
  }
}

function clone(world: FakeWorld): FakeWorld {
  return JSON.parse(JSON.stringify(world)) as FakeWorld;
}
