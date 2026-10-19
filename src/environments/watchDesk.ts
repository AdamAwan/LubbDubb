import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { GoalWatch, WatchWindow } from '../types.js';
import type { EnvironmentObserver } from './observer.js';
import type { EnvironmentConfig } from './policy.js';
import { watchFindings, watchWindowReadings } from './watchFinding.js';
import { watchCheckVerdict } from './watchVerdict.js';
import { dueWindows, openableArrivals, settlingWindows, watchWindowMs } from './watchWindow.js';
import { exposureFloor, exposureShortfall, watchSince } from './exposure.js';
import { landedCommits } from './landings.js';

// → docs/spec/24-environments.md

interface WatchDeskDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
  probeIntervalMs: number;
  watchIntervalMs: number;
  errors?: ErrorRecorder;
  now?: () => number;
}

export class WatchDesk {
  private readonly now: () => number;

  constructor(private readonly deps: WatchDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** @public the pass `EnvironmentDesk` runs below its own arrival pass */
  async run(): Promise<void> {
    if (!this.deps.environments.some((e) => e.watch !== undefined)) return;
    this.open();
    this.settle();
    await this.read();
    this.file();
  }

  private file(): void {
    const { store, errors } = this.deps;
    try {
      const steps = watchFindings({
        readings: watchWindowReadings({
          windows: store.watches.listWatchWindows(),
          checks: store.watches.listGoalWatches(),
          readings: store.watches.listWatchReadings(),
          environments: this.deps.environments,
        }),
        existing: store.humanTasks.listHumanTasksOfKind('watch'),
      });
      for (const step of steps) {
        if (step.kind === 'file')
          store.humanTasks.recordHumanTask({
            title: step.title,
            detail: step.detail,
            originRef: step.originRef,
            kind: 'watch',
            agentId: null,
            taskId: null,
          });
        else if (step.kind === 'reopen') store.humanTasks.reopenHumanTask(step.taskId, step.detail);
        else store.humanTasks.settleHumanTask(step.taskId, step.status, step.resolution);
      }
    } catch (err) {
      errors?.record({ source: 'cycle', message: `filing watch findings failed: ${(err as Error).message}` });
    }
  }

  private open(): void {
    const { store, errors } = this.deps;
    try {
      const declared = new Set(store.watches.listGoalWatches().map((c) => c.originRef));
      for (const { arrival, settlesAt } of openableArrivals({
        arrivals: store.environments.listGoalArrivals(),
        environments: this.deps.environments,
        declared,
        probeIntervalMs: this.deps.probeIntervalMs,
        now: this.now(),
      })) {
        if (settlesAt !== null)
          store.watches.openWatchWindow({
            goalRef: arrival.goalRef,
            environment: arrival.environment,
            openedAt: arrival.arrivedAt,
            settlesAt,
          });
        store.environments.markArrivalWatched(arrival.goalRef, arrival.environment);
      }
    } catch (err) {
      errors?.record({ source: 'cycle', message: `opening watch windows failed: ${(err as Error).message}` });
    }
  }

  private settle(): void {
    const { store, errors } = this.deps;
    try {
      for (const window of settlingWindows(store.watches.listWatchWindows(), this.now()))
        store.watches.settleWatchWindow(window.goalRef, window.environment);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `settling watch windows failed: ${(err as Error).message}` });
    }
  }

  private async read(): Promise<void> {
    const { store, errors } = this.deps;
    let due: WatchWindow[];
    try {
      due = dueWindows({
        windows: store.watches.listWatchWindows(),
        readings: store.watches.listWatchReadings(),
        watchIntervalMs: this.deps.watchIntervalMs,
        now: this.now(),
      });
    } catch (err) {
      errors?.record({ source: 'cycle', message: `choosing watch windows to read failed: ${(err as Error).message}` });
      return;
    }
    const byName = new Map(this.deps.environments.map((e) => [e.name, e]));
    const checks = store.watches.listGoalWatches();
    const landings = store.environments.listGoalLandings();
    for (const opened of due) {
      const environment = byName.get(opened.environment);
      if (environment?.watch === undefined) continue;
      const mine = checks.filter((c) => c.originRef === opened.goalRef);
      if (mine.length === 0) continue;
      const commits = landedCommits(landings, opened.goalRef);
      let window: WatchWindow | null;
      try {
        window = await this.exposed(environment, opened, mine, commits);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message: `reading exposure on ${opened.environment} for ${opened.goalRef} failed: ${(err as Error).message}`,
        });
        continue;
      }
      if (window === null) continue;
      for (const check of mine) {
        try {
          await this.readCheck(environment, window, check, commits);
        } catch (err) {
          errors?.record({
            source: 'cycle',
            message: `reading ${check.id} on ${window.environment} for ${window.goalRef} failed: ${(err as Error).message}`,
          });
        }
      }
    }
  }

  /**
   * The window to read, or null where the rollout has not reached enough of the environment — in which
   * case every check is recorded `unknown` and no query is run. → docs/spec/29-post-deploy-watch.md#exposure
   */
  private async exposed(
    environment: EnvironmentConfig,
    window: WatchWindow,
    checks: readonly GoalWatch[],
    commits: readonly string[],
  ): Promise<WatchWindow | null> {
    const exposure = environment.watch!.exposure;
    if (exposure === undefined) return window;
    const reading = await this.deps.observer.exposure({
      environment: environment.name,
      command: exposure.command,
      commits,
    });
    const shortfall = exposureShortfall(environment.name, reading, exposureFloor(environment));
    if (shortfall !== null) {
      for (const check of checks)
        this.deps.store.watches.recordWatchReading({
          goalRef: window.goalRef,
          environment: window.environment,
          checkId: check.id,
          value: null,
          verdict: 'unknown',
          rows: null,
          detail: shortfall,
        });
      return null;
    }
    if (window.exposedAt !== null) return window;
    const now = this.now();
    const exposedAt = new Date(now).toISOString();
    const settlesAt = new Date(now + watchWindowMs(environment)).toISOString();
    this.deps.store.watches.markWatchWindowExposed(window.goalRef, window.environment, exposedAt, settlesAt);
    return { ...window, exposedAt, settlesAt };
  }

  private async readCheck(
    environment: EnvironmentConfig,
    window: WatchWindow,
    check: GoalWatch,
    commits: readonly string[],
  ): Promise<void> {
    const command = environment.watch!.observe;
    const since = watchSince(window);
    const presence =
      check.presence === null
        ? null
        : await this.deps.observer.observe({
            environment: environment.name,
            command,
            checkId: check.id,
            query: check.presence,
            kind: 'presence',
            since,
            commits,
          });
    const silent = presence !== null && (presence.rows === null || presence.rows.length === 0);
    const reading = silent
      ? presence!
      : await this.deps.observer.observe({
          environment: environment.name,
          command,
          checkId: check.id,
          query: check.query,
          kind: check.kind === 'measure' ? 'measure' : 'signal',
          since,
          commits,
        });
    const verdict = watchCheckVerdict({ check, environment: environment.name, presence, reading });
    this.deps.store.watches.recordWatchReading({
      goalRef: window.goalRef,
      environment: window.environment,
      checkId: check.id,
      value: reading.value,
      ...verdict,
    });
  }
}
