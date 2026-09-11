import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { GoalWatch, WatchWindow } from '../types.js';
import type { EnvironmentObserver } from './observer.js';
import type { EnvironmentConfig } from './policy.js';
import { watchFindings, watchWindowReadings } from './watchFinding.js';
import { watchCheckVerdict } from './watchVerdict.js';
import { dueWindows, openableArrivals, settlingWindows } from './watchWindow.js';

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
          windows: store.listWatchWindows(),
          checks: store.listGoalWatches(),
          readings: store.listWatchReadings(),
          environments: this.deps.environments,
        }),
        existing: store.listHumanTasksOfKind('watch'),
      });
      for (const step of steps) {
        if (step.kind === 'file')
          store.recordHumanTask({
            title: step.title,
            detail: step.detail,
            originRef: step.originRef,
            kind: 'watch',
            agentId: null,
            taskId: null,
          });
        else if (step.kind === 'reopen') store.reopenHumanTask(step.taskId, step.detail);
        else store.settleHumanTask(step.taskId, step.status, step.resolution);
      }
    } catch (err) {
      errors?.record({ source: 'cycle', message: `filing watch findings failed: ${(err as Error).message}` });
    }
  }

  private open(): void {
    const { store, errors } = this.deps;
    try {
      const declared = new Set(store.listGoalWatches().map((c) => c.originRef));
      for (const { arrival, settlesAt } of openableArrivals({
        arrivals: store.listGoalArrivals(),
        environments: this.deps.environments,
        declared,
        probeIntervalMs: this.deps.probeIntervalMs,
        now: this.now(),
      })) {
        if (settlesAt !== null)
          store.openWatchWindow({
            goalRef: arrival.goalRef,
            environment: arrival.environment,
            openedAt: arrival.arrivedAt,
            settlesAt,
          });
        store.markArrivalWatched(arrival.goalRef, arrival.environment);
      }
    } catch (err) {
      errors?.record({ source: 'cycle', message: `opening watch windows failed: ${(err as Error).message}` });
    }
  }

  private settle(): void {
    const { store, errors } = this.deps;
    try {
      for (const window of settlingWindows(store.listWatchWindows(), this.now()))
        store.settleWatchWindow(window.goalRef, window.environment);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `settling watch windows failed: ${(err as Error).message}` });
    }
  }

  private async read(): Promise<void> {
    const { store, errors } = this.deps;
    let due: WatchWindow[];
    try {
      due = dueWindows({
        windows: store.listWatchWindows(),
        readings: store.listWatchReadings(),
        watchIntervalMs: this.deps.watchIntervalMs,
        now: this.now(),
      });
    } catch (err) {
      errors?.record({ source: 'cycle', message: `choosing watch windows to read failed: ${(err as Error).message}` });
      return;
    }
    const byName = new Map(this.deps.environments.map((e) => [e.name, e]));
    const checks = store.listGoalWatches();
    for (const window of due) {
      const environment = byName.get(window.environment);
      if (environment?.watch === undefined) continue;
      for (const check of checks.filter((c) => c.originRef === window.goalRef)) {
        try {
          await this.readCheck(environment, window, check);
        } catch (err) {
          errors?.record({
            source: 'cycle',
            message: `reading ${check.id} on ${window.environment} for ${window.goalRef} failed: ${(err as Error).message}`,
          });
        }
      }
    }
  }

  private async readCheck(environment: EnvironmentConfig, window: WatchWindow, check: GoalWatch): Promise<void> {
    const command = environment.watch!.observe;
    const presence =
      check.presence === null
        ? null
        : await this.deps.observer.observe({
            environment: environment.name,
            command,
            checkId: check.id,
            query: check.presence,
            kind: 'presence',
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
        });
    const verdict = watchCheckVerdict({ check, environment: environment.name, presence, reading });
    this.deps.store.recordWatchReading({
      goalRef: window.goalRef,
      environment: window.environment,
      checkId: check.id,
      value: reading.value,
      ...verdict,
    });
  }
}
