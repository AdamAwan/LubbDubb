import type { Config } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { EnvironmentReading, GoalLanding } from '../types.js';
import type { AppErrorsPayload } from '../wire.js';
import { appErrorProject } from './key.js';
import type { AppErrorLinker } from './linker.js';
import { withTrackers } from './tracker.js';
import { withTriage } from './triage.js';
import { appErrorsView } from './view.js';

// → docs/spec/39-app-errors.md#where-it-is-computed

type CurrentConfig = Pick<
  Config,
  'environments' | 'appErrorMinCount' | 'appErrorIgnore' | 'pool' | 'github' | 'azureDevOps' | 'repoRoot'
>;

/** A linked payload is reused this long while nothing it was built from has moved. */
const REUSE_MS = 30_000;

/** The payload with every `link`, `tracker` and `triage` still null: the tracker desk's reading, which needs only keys and states. */
export function appErrorView(store: Store, config: CurrentConfig, now: number): AppErrorsPayload {
  return appErrorsView({
    environments: config.environments,
    reads: store.appErrors.listReads(),
    groups: store.appErrors.listGroups(),
    heads: store.environments.listEnvironmentHeads(),
    project: appErrorProject(config),
    minCount: config.appErrorMinCount,
    ignore: config.appErrorIgnore,
    now,
  });
}

interface CurrentAppErrorsDeps {
  store: Store;
  config: CurrentConfig;
  linker: AppErrorLinker;
}

/**
 * The one builder of the linked payload — the Errors tab's, every goal badge's, every press's and the
 * triage desk's. A linked pass is reused while nothing it was built from has moved.
 */
export class CurrentAppErrors {
  private held: { key: string; builtAt: number; payload: AppErrorsPayload } | null = null;

  constructor(private readonly deps: CurrentAppErrorsDeps) {}

  async read(now: number): Promise<AppErrorsPayload> {
    return (await this.readLinked(now)).payload;
  }

  /** What a group's link is drawn from besides the reads: while it holds, a linked episode stays linked. */
  linkBasis(): string {
    const { store } = this.deps;
    return this.basis(
      store.environments.listGoalLandings(),
      store.environments.listEnvironmentReach(),
      store.graph.listWorkNodes(),
    );
  }

  /** `answered` is false when the deadline cut some question to the clone off. */
  async readLinked(now: number): Promise<{ payload: AppErrorsPayload; answered: boolean }> {
    const { store, config, linker } = this.deps;
    const landings = store.environments.listGoalLandings();
    const readings = store.environments.listEnvironmentReach();
    const nodes = store.graph.listWorkNodes();
    const key = [
      ...store.appErrors.listReads().map((r) => `${r.environment}@${r.readAt}`),
      this.basis(landings, readings, nodes),
    ].join('\n');
    let linked = this.held?.key === key && now - this.held.builtAt < REUSE_MS ? this.held.payload : null;
    let answered = true;
    if (linked === null) {
      linked = appErrorView(store, config, now);
      answered = await linker.link(linked, { landings, readings, nodes, now });
      this.held = answered ? { key, builtAt: now, payload: linked } : null;
    }
    const tracked = withTrackers(linked, store.appErrorTickets.listSearches());
    const payload = withTriage(tracked, {
      triages: store.appErrorTriage.listTriages(),
      reads: store.appErrorTriage.listDetailReads(),
      open: store.appErrorTriage.openRunNow(),
    });
    return { payload, answered };
  }

  private basis(
    landings: readonly GoalLanding[],
    readings: readonly EnvironmentReading[],
    nodes: readonly { ref: string }[],
  ): string {
    const { store, config } = this.deps;
    return [
      ...store.environments.listEnvironmentHeads().map((h) => `${h.environment}=${h.sha}@${h.changedAt ?? ''}`),
      `landings ${landings.map((l) => `${String(l.prNumber)}=${l.sha}:${String(l.onIntegration)}`).join(',')}`,
      `reach ${String(readings.length)} ${readings.reduce((max, r) => (r.observedAt > max ? r.observedAt : max), '')}`,
      `nodes ${String(nodes.length)}`,
      `min ${String(config.appErrorMinCount)} ignore ${config.appErrorIgnore.join(',')}`,
    ].join('\n');
  }
}
