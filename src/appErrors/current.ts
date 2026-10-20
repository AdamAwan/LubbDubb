import type { Config } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { AppErrorsPayload } from '../wire.js';
import { appErrorProject } from './key.js';
import { withTrackers } from './tracker.js';
import { appErrorsView } from './view.js';

// → docs/spec/39-app-errors.md#on-the-wire

type CurrentConfig = Pick<
  Config,
  'environments' | 'appErrorMinCount' | 'appErrorIgnore' | 'pool' | 'github' | 'azureDevOps' | 'repoRoot'
>;

/** The Errors tab's payload as it stands: the route's answer, and what the tracker desk reads moved keys from. */
export function currentAppErrors(store: Store, config: CurrentConfig, now: number): AppErrorsPayload {
  const view = appErrorsView({
    environments: config.environments,
    reads: store.appErrors.listReads(),
    groups: store.appErrors.listGroups(),
    heads: store.environments.listEnvironmentHeads(),
    project: appErrorProject(config),
    minCount: config.appErrorMinCount,
    ignore: config.appErrorIgnore,
    now,
  });
  return withTrackers(view, store.appErrorTickets.listSearches());
}
