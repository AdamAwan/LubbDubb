import type { Config } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { AppErrorsPayload } from '../wire.js';
import { appErrorProject } from './key.js';
import type { AppErrorLinker } from './linker.js';
import { withTrackers } from './tracker.js';
import { appErrorsView } from './view.js';

// → docs/spec/39-app-errors.md#on-the-wire

type CurrentConfig = Pick<
  Config,
  'environments' | 'appErrorMinCount' | 'appErrorIgnore' | 'pool' | 'github' | 'azureDevOps' | 'repoRoot'
>;

/** The payload with every `link` still null: the tracker desk's reading, which needs only keys and states. */
export function unlinkedAppErrors(store: Store, config: CurrentConfig, now: number): AppErrorsPayload {
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

/** The Errors tab's payload as the tab draws it, links included: the route's answer and what every press acts on. */
export async function currentAppErrors(
  store: Store,
  config: CurrentConfig,
  linker: AppErrorLinker,
  now: number,
): Promise<AppErrorsPayload> {
  const payload = unlinkedAppErrors(store, config, now);
  await linker.link(payload, {
    landings: store.environments.listGoalLandings(),
    readings: store.environments.listEnvironmentReach(),
    nodes: store.graph.listWorkNodes(),
    now,
  });
  return payload;
}
