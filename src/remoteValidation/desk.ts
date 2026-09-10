import type { ErrorRecorder } from '../errorLog.js';
import type { EnvironmentObserver } from '../environments/observer.js';
import type { EnvironmentConfig } from '../environments/policy.js';
import { sheetableArrivals } from '../environments/watchWindow.js';
import { watchCheckVerdict } from '../environments/watchVerdict.js';
import type { WatchResult } from '../environments/watchResult.js';
import type { Store } from '../store/store.js';
import { isActiveTask } from '../tasks.js';
import { queryDigest } from '../store/remoteValidation.js';
import type { GoalArrival, GoalWatch, RemoteRowOutcome, StateQuery } from '../types.js';
import { preflightRows } from './preflight.js';
import type { RemoteRunner, SelectorListing } from './runner.js';
import { sheetRows, type SheetRowPlan, type SheetRowRun } from './sheet.js';
import type { StateQueryDesk } from './stateQueries.js';
import { resolveTenant, type TenantEnvironment } from './tenants.js';

// → docs/spec/36-remote-validation.md

/**
 * How often a browser environment's runner is asked what it offers, outside the pre-flight's own
 * listing. It is a process spawn per environment under the runner's 30-second kill, against an
 * offering that changes when a spec is added or renamed — so it is paced to the suite's own rate of
 * change rather than to the pulse's.
 */
const SELECTOR_LISTING_INTERVAL_MS = 30 * 60 * 1000;

const SWEPT =
  'the agent dispatched to run it ended without reporting — its transcript says what happened. ' +
  'Nothing was read, so nothing was written on the sheet.';

interface RemoteValidationDeskDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
  queries: StateQueryDesk;
  runner: RemoteRunner;
  probeIntervalMs: number;
  errors?: ErrorRecorder;
  now?: () => number;
  /** Where a `tenantEnv`'s value is read from. Injected so a test never reads the machine's own. */
  env?: TenantEnvironment;
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
    await this.refreshSelectorOfferings();
    await this.assembleAll();
    this.sweep();
  }

  /**
   * Ask each browser environment's runner what it offers, and keep the answer where a planner can be
   * shown it. The pre-flight already takes this listing, but only when a goal arrives — and a planner
   * needs the offering *before* there is anything to arrive, on a deployment where nothing has
   * arrived yet. So the listing is taken on its own clock as well, and the pre-flight's own answer is
   * folded in on the way past.
   *
   * It is a **convenience and never an authority**. A planner picks an area from a listing taken on
   * one commit and the run happens against another, so the pre-flight asks the deployed runner again
   * at assembly and its answer is what a row blocks on. A stale cache costs a refusal at plan
   * submission that the pre-flight would have made anyway; the reverse — trusting it at the press —
   * would be the harness reporting on a listing nobody took.
   */
  private async refreshSelectorOfferings(): Promise<void> {
    const listed = new Map(this.deps.store.listSelectorOfferings().map((o) => [o.environment, o.listedAt]));
    for (const environment of this.deps.environments) {
      const command = environment.validate?.browser?.listSelectors;
      if (command === undefined) continue;
      const at = listed.get(environment.name);
      if (at !== undefined && this.now() - Date.parse(at) < SELECTOR_LISTING_INTERVAL_MS) continue;
      try {
        await this.listSelectors(environment, command);
      } catch (err) {
        this.deps.errors?.record({
          source: 'cycle',
          message: `listing the selectors ${environment.name} offers failed: ${(err as Error).message}`,
        });
      }
    }
  }

  /**
   * One listing, and the one place a listing is taken. An answered one is recorded on the way back;
   * one that could not say records nothing, leaving the offering the last answer left standing — an
   * empty offering read as an answer is a planner told this deployment has no areas at all.
   */
  private async listSelectors(environment: EnvironmentConfig, command: string): Promise<SelectorListing> {
    const listing = await this.deps.runner.listSelectors({
      environment: environment.name,
      command,
      profile: environment.validate?.browser?.profile ?? null,
      tenant: resolveTenant({
        environment,
        stamped: this.deps.store.listRemoteTenants(),
        now: this.now(),
        env: this.deps.env,
      }).value,
      selectors: [],
      reportDir: null,
    });
    if (listing.offers !== null)
      this.deps.store.recordSelectorOffering(environment.name, listing.offers, new Date(this.now()).toISOString());
    return listing;
  }

  private async assembleAll(): Promise<void> {
    const { store, errors } = this.deps;
    let considered: { arrival: GoalArrival; assemble: boolean }[];
    try {
      considered = sheetableArrivals({
        arrivals: store.listGoalArrivals(),
        environments: this.deps.environments,
        authored: (goalRef) =>
          store.getValidationPlanRecord(goalRef)?.authoredAt != null || store.listValidationChecks(goalRef).length > 0,
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
   * A `dispatched` run whose task is no longer active. An agent that crashed, was killed or spent
   * its stall park leaves a run nobody will ever report against, the `(environment, tenant)` lock
   * held over it and the sheet's press absent for good — `LocalValidationDesk`'s second arm exactly,
   * and the settle path an operator's own `.../cancel` route was until this landed.
   *
   * The bias is to leave a run alone. Settling one whose agent is still working loses the reading it
   * was about to report and frees the lock underneath it, so a second press opens a run against a
   * tenant somebody is already driving — a silent wrong answer rather than a visible clash. So
   * `pending` is never touched, and a `dispatched` run with no task named, or one naming a task this
   * build cannot resolve, is a run the sweep **cannot say** about and is left standing: `unknown` is
   * folded into neither arm here, as it is nowhere else in this subsystem.
   *
   * It writes no reading, no check result and nothing on a row: a run nobody reported against
   * learned nothing about the goal, `handback`'s rule.
   */
  private sweep(): void {
    const { store, errors } = this.deps;
    try {
      for (const run of store.listRemoteRuns()) {
        if (run.status !== 'dispatched' || run.taskId === null) continue;
        const task = store.getTask(run.taskId);
        if (task === null || isActiveTask(task)) continue;
        store.endRemoteRun(run.id, { status: 'abandoned', note: SWEPT });
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `the remote validation sweep failed: ${(err as Error).message}`,
      });
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
    await this.preflight(environment, goalRef, rows);
    for (const row of rows) await this.read(environment, goalRef, row);
  }

  /**
   * Ask the deployed runner which selectors it actually offers, and read that listing against what
   * this sheet's `check` rows name. It runs on the **assembly** pass only and inside its cap: it is
   * a process spawn per sheet, which is why the cap is five rather than the watch's twenty.
   *
   * It is here rather than after a press because a mismatch is one of this design's own `blocked`
   * causes — a check whose selector nobody can find is a check that needs rewording, and telling an
   * operator that at the gate is the difference between an amendment and a wasted press.
   */
  private async preflight(
    environment: EnvironmentConfig,
    goalRef: string,
    rows: readonly SheetRowPlan[],
  ): Promise<void> {
    const command = environment.validate?.browser?.listSelectors;
    if (command === undefined) return;
    const asks = rows.filter((row) => row.kind === 'check' && row.blockedReason === null);
    if (asks.length === 0) return;
    const checks = this.deps.store.listValidationChecks(goalRef);
    if (!checks.some((check) => check.area !== null && asks.some((row) => row.sourceId === check.id))) return;
    try {
      const listing = await this.listSelectors(environment, command);
      this.deps.store.recordRemotePreflight(
        goalRef,
        environment.name,
        preflightRows({ environment: environment.name, rows: asks, checks, listing }),
      );
    } catch (err) {
      this.deps.errors?.record({
        source: 'cycle',
        message: `the pre-flight for ${goalRef} on ${environment.name} failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * One row's reading, taken on its own. Every failure here is `blocked` on **this** row: a state
   * row on a machine that cannot reach the store leaves every other row on the sheet reporting, and
   * `failed` on an unreachable store would dispatch `validation-failed` at code that is fine.
   */
  private async read(environment: EnvironmentConfig, goalRef: string, row: SheetRowPlan): Promise<void> {
    if (row.blockedReason !== null || row.run === null) return;
    const reading = await this.readRow(environment, goalRef, row.run, row.sourceId);
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
      startedSha: null,
      endedSha: null,
      // A deterministic row is a query, not a suite: nothing here matched, ran, retried or published.
      executed: null,
      retries: null,
      durationMs: null,
      artefacts: null,
    });
  }

  /**
   * One row's reading, taken through the same two readers the assembly used. The press re-runs a
   * confirmed row through this rather than a second reader, which would be free to disagree with
   * the assembly about what a row of that kind is.
   *
   * @public the seam `RemoteRunDesk` re-reads a confirmed row through
   */
  async readRow(
    environment: EnvironmentConfig,
    goalRef: string,
    run: Exclude<SheetRowRun, null>,
    sourceId: string,
  ): Promise<RowReading | null> {
    return run === 'state'
      ? this.readState(environment, goalRef, sourceId)
      : this.readWatch(environment, goalRef, sourceId);
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

/** @public what a re-read row came back as, before anything is written down about it */
export interface RowReading {
  outcome: RemoteRowOutcome;
  rows: number | null;
  value: number | null;
  detail: string | null;
}
