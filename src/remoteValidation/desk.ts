import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentObserver } from '../environments/observer.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { sheetableArrivals } from '../environments/watchWindow.js';
import { watchCheckVerdict } from '../environments/watchVerdict.js';
import type { WatchResult } from '../environments/watchResult.js';
import type { Store } from '../store/store.js';
import { queryDigest } from '../store/remoteValidation.js';
import type { GoalArrival, GoalWatch, RemoteRowOutcome, StateQuery } from '../types.js';
import { sheetRows, type SheetRowPlan } from './sheet.js';
import type { StateQueryDesk } from './stateQueries.js';

// → docs/spec/36-remote-validation.md

interface RemoteValidationDeskDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
  queries: StateQueryDesk;
  probeIntervalMs: number;
  errors?: ErrorRecorder;
  now?: () => number;
}

/**
 * The one owner of every sheet write. It runs below `EnvironmentDesk`'s arrival pass — above it,
 * every sheet would be one pulse late forever, with nothing red — and above `ValidationReadyDesk`,
 * so the bench row an operator reads at the moment they decide to press states this pulse's sheet
 * rather than the one before the readings landed.
 */
export class RemoteValidationDesk {
  private readonly now: () => number;

  constructor(private readonly deps: RemoteValidationDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** @public the pass `Harness.runCycle` runs below `EnvironmentDesk` */
  async run(): Promise<void> {
    if (!this.deps.environments.some((e) => e.validate !== undefined)) return;
    const { store, errors } = this.deps;
    let considered: { arrival: GoalArrival; assemble: boolean }[];
    try {
      considered = sheetableArrivals({
        arrivals: store.listGoalArrivals(),
        environments: this.deps.environments,
        probeIntervalMs: this.deps.probeIntervalMs,
        now: this.now(),
      });
    } catch (err) {
      errors?.record({ source: 'cycle', message: `choosing arrivals to sheet failed: ${(err as Error).message}` });
      return;
    }
    for (const { arrival, assemble } of considered) {
      try {
        if (assemble) await this.assemble(arrival);
        store.markArrivalSheeted(arrival.goalRef, arrival.environment);
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message:
            `assembling the validation sheet for ${arrival.goalRef} on ${arrival.environment} failed: ` +
            `${(err as Error).message}`,
        });
      }
    }
  }

  /**
   * The second key, for a live watch check: an operator has read this query and accepted it *here*.
   * The watch put it to one environment to learn whether it parses; a sheet puts it to a named place,
   * and consent to a place is not transferable — so a check live on the watch is still blocked on a
   * sheet until its digest has been accepted against that environment.
   *
   * @public the seam the sheet's approval route writes an operator's consent to a watch query through
   */
  async ruleWatchQuery(
    originRef: string,
    checkId: string,
    environmentName: string,
    accept: boolean,
  ): Promise<{ check: GoalWatch; reading: RowReading | null; approved: boolean } | null> {
    const check = this.deps.store.listGoalWatches().find((c) => c.originRef === originRef && c.id === checkId);
    if (check === undefined) return null;
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    if (environment === undefined) return null;
    const digest = queryDigest(check.query, check.presence ?? '');
    if (!accept) {
      this.deps.store.declineStateQuery(digest, environment.name);
      return { check, reading: null, approved: false };
    }
    const reading = await this.readWatch(environment, originRef, checkId);
    if (reading === null || reading.outcome === 'blocked') return { check, reading, approved: false };
    this.deps.store.approveStateQuery({
      digest,
      environment: environment.name,
      originRef,
      queryId: checkId,
      rows: reading.rows,
      detail: reading.detail,
    });
    return { check, reading, approved: true };
  }

  private async assemble(arrival: GoalArrival): Promise<void> {
    const { store } = this.deps;
    const environment = this.deps.environments.find((e) => e.name === arrival.environment);
    if (environment === undefined) return;
    const goalRef = arrival.goalRef;
    const rows = sheetRows({
      environment,
      checks: store.listValidationChecks(goalRef),
      watches: store.listGoalWatches().filter((w) => w.originRef === goalRef),
      queries: store.listStateQueries().filter((q) => q.originRef === goalRef),
      approvals: new Set(store.listStateQueryApprovals().map((a) => `${a.digest} ${a.environment}`)),
    });
    store.openRemoteSheet({ goalRef, environment: environment.name });
    store.saveRemoteSheetRows(
      goalRef,
      environment.name,
      rows.map(({ run: _run, ...row }) => row),
    );
    for (const row of rows) await this.read(environment, goalRef, row);
  }

  /**
   * One row's reading, taken on its own. Every failure here is `blocked` on **this** row: a state
   * row on a machine that cannot reach the store leaves every other row on the sheet reporting, and
   * `failed` on an unreachable store would dispatch `validation-failed` at code that is fine.
   */
  private async read(environment: EnvironmentConfig, goalRef: string, row: SheetRowPlan): Promise<void> {
    if (row.blockedReason !== null || row.run === null) return;
    const reading =
      row.run === 'state'
        ? await this.readState(environment, goalRef, row.sourceId)
        : await this.readWatch(environment, goalRef, row.sourceId);
    if (reading === null) return;
    if (reading.outcome === 'blocked') {
      this.deps.store.blockRemoteSheetRow(
        goalRef,
        environment.name,
        row.rowId,
        reading.detail ?? 'no reading was taken',
      );
      return;
    }
    this.deps.store.recordRemoteReading({
      goalRef,
      environment: environment.name,
      rowId: row.rowId,
      runId: null,
      outcome: reading.outcome,
      rows: reading.rows,
      value: reading.value,
      detail: reading.detail,
    });
  }

  private async readState(
    environment: EnvironmentConfig,
    goalRef: string,
    queryId: string,
  ): Promise<RowReading | null> {
    const query: StateQuery | undefined = this.deps.store
      .listStateQueries()
      .find((q) => q.originRef === goalRef && q.id === queryId);
    if (query === undefined) return null;
    const reading = await this.deps.queries.read(environment, query);
    if (reading.blocked !== null) return { outcome: 'blocked', rows: null, value: null, detail: reading.blocked };
    const rows = reading.rows ?? 0;
    if (rows === 0) return { outcome: 'passed', rows, value: null, detail: null };
    return {
      outcome: 'failed',
      rows,
      value: null,
      detail:
        `${environment.name} answered ${String(rows)} row${rows === 1 ? '' : 's'} where the query declared none ` +
        'should match.',
    };
  }

  private async readWatch(
    environment: EnvironmentConfig,
    goalRef: string,
    checkId: string,
  ): Promise<RowReading | null> {
    const check: GoalWatch | undefined = this.deps.store
      .listGoalWatches()
      .find((c) => c.originRef === goalRef && c.id === checkId);
    if (check === undefined) return null;
    const command = environment.watch?.observe;
    if (command === undefined) return null;
    const presence: WatchResult | null =
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
    const result = silent
      ? presence
      : await this.deps.observer.observe({
          environment: environment.name,
          command,
          checkId: check.id,
          query: check.query,
          kind: check.kind === 'measure' ? 'measure' : 'signal',
        });
    const verdict = watchCheckVerdict({ check, environment: environment.name, presence, reading: result });
    if (verdict.verdict === 'unknown') return { outcome: 'blocked', rows: null, value: null, detail: verdict.detail };
    return {
      outcome: verdict.verdict === 'clean' ? 'passed' : 'failed',
      rows: verdict.rows,
      value: result.value,
      detail: verdict.detail,
    };
  }
}

interface RowReading {
  outcome: RemoteRowOutcome;
  rows: number | null;
  value: number | null;
  detail: string | null;
}
