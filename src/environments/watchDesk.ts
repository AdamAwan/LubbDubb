import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { GoalWatch, WatchWindow } from '../types.js';
import type { EnvironmentObserver } from './observer.js';
import type { EnvironmentConfig } from './policy.js';
import { watchFindings, watchWindowReadings } from './watchFinding.js';
import { watchCheckVerdict } from './watchVerdict.js';
import { dueWindows, openableArrivals, settlingWindows } from './watchWindow.js';

/** What the desk needs: the store, the operator's list, the seam, and the two clocks. */
interface WatchDeskDeps {
  store: Store;
  /** The operator's list. An environment without a `watch` is observed for reach and nothing more. */
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
  /** What "fresh" means for an arrival — the same interval the probe pass runs on. */
  probeIntervalMs: number;
  /** How often an **open** window asks its environment again. */
  watchIntervalMs: number;
  errors?: ErrorRecorder;
  /** Injectable clock, so a test decides what "due" means rather than waiting two days. */
  now?: () => number;
}

/**
 * The window pass: open a watch on an arrival, ask the environment on
 * `watchIntervalMs`, and settle at `for`.
 *
 * A pass on `EnvironmentDesk` rather than a desk of its own, and **below the
 * arrival pass** rather than beside it: a window opens on an arrival the pass above
 * records, so above it this reads arrivals that have not been written yet and the
 * whole feature is one pulse late forever, with nothing red.
 *
 * Three steps, in an order that is itself load-bearing:
 *
 * 1. **Open**, for every fresh arrival, stamping every arrival considered either
 *    way — the guard that stops the first pulse after this ships from opening a
 *    window on every goal that ever arrived.
 * 2. **Settle**, before anything is read, so a window that ran out between two
 *    pulses stops at its own end rather than collecting one more reading past it.
 * 3. **Read**, capped, oldest window first, deferring rather than dropping.
 * 4. **File**, for a window that is settled or settling regressed — one bench row
 *    per window and never one per reading. Last, so it is filed off the reading
 *    this pulse just took rather than the one before it.
 *
 * No model runs in any of it. The expectation is declared, the comparison is
 * arithmetic, and a verdict that came from a judgement nobody can reproduce would
 * be worse than no verdict. → `docs/spec/29-post-deploy-watch.md#the-window`
 *
 * A failure is recorded and never fails the cycle.
 */
export class WatchDesk {
  private readonly now: () => number;

  constructor(private readonly deps: WatchDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** @public the pass `EnvironmentDesk` runs below its own arrival pass */
  async run(): Promise<void> {
    // Nothing declares telemetry, so there is nothing to open a window against and
    // nothing an arrival could be watched for. Off by default, in `environments`'
    // own terms — and stamping arrivals here would spend the one guard that makes
    // turning it on later safe.
    if (!this.deps.environments.some((e) => e.watch !== undefined)) return;
    this.open();
    this.settle();
    await this.read();
    this.file();
  }

  /**
   * Say on the bench that an environment is answering outside what the goal
   * declared.
   *
   * It writes `human_tasks` rows and nothing else — it dispatches nobody, touches
   * no sink, and no rule reads what it writes. That is the bound the whole
   * subsystem is built on: a watch cannot spend an agent even by accident, and the
   * route from a reading to new work is an operator's click on the row this files.
   */
  private file(): void {
    const { store, errors } = this.deps;
    try {
      const steps = watchFindings({
        readings: watchWindowReadings({
          windows: store.listWatchWindows(),
          checks: store.listGoalWatches(),
          readings: store.listWatchReadings(),
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

  /**
   * Open a window on every arrival the harness watched happen, and stamp every
   * arrival it considered.
   *
   * The stamp goes down whether or not a window was opened, which is the whole of
   * how a deployment that adds a `watch` next month watches its *next* arrival
   * rather than opening a window on its entire history.
   */
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

  /** Fix the verdict on every window whose `for` has run out. A settled watch is never re-opened. */
  private settle(): void {
    const { store, errors } = this.deps;
    try {
      for (const window of settlingWindows(store.listWatchWindows(), this.now()))
        store.settleWatchWindow(window.goalRef, window.environment);
    } catch (err) {
      errors?.record({ source: 'cycle', message: `settling watch windows failed: ${(err as Error).message}` });
    }
  }

  /** Ask each due window's environment about each of the goal's declared checks. */
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
      // The operator removed the environment, or its `watch`, while a window was
      // open. Nothing to ask; the window settles at its own `for` either way.
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

  /**
   * One check, put to one environment: the presence query first, then the check's
   * own — `WatchDryRun`'s order, and for its reason.
   *
   * Presence is what decides whether the second answer means anything, so a silent
   * presence query is `unknown` and the check's own query is **not asked**. It also
   * halves the spend on exactly the environment where it is wasted: an acceptance
   * environment where the scheduled job does not run answers zero to everything.
   */
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
      // The measure's **now**, taken off the observation rather than out of the
      // fold: the fold's job is the ruling, and a number that only existed inside
      // it could not be drawn beside the before the card is worth looking at for.
      value: reading.value,
      ...verdict,
    });
  }
}
