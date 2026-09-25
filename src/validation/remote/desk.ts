import type { ErrorRecorder } from '../../errorLog.js';
import type { EnvironmentObserver } from '../../environments/observer.js';
import type { EnvironmentConfig } from '../../environments/policy.js';
import { sheetableArrivals, watchWindowMs } from '../../environments/watchWindow.js';
import { watchCheckVerdict } from '../../environments/watchVerdict.js';
import type { WatchResult } from '../../environments/watchResult.js';
import { issueOriginNumber } from '../../issueOrigins.js';
import { readFile } from 'node:fs/promises';
import type { ActionSink, IssueImageSink } from '../../sink/actionSink.js';
import { validationResourcePath } from '../resources.js';
import type { Store } from '../../store/store.js';
import { isActiveTask } from '../../tasks.js';
import { checkSetReleased } from '../planApproval.js';
import { sweptScripts } from '../steps.js';
import { queryDigest } from '../../store/remoteValidation.js';
import type { GoalArrival, GoalWatch, RemoteRowOutcome, StateQuery } from '../../types.js';
import { captureComment, postableCaptures, type CaptureLink, type PostableCapture } from './capturePost.js';
import { sheetRows, type SheetRowPlan, type SheetRowRun } from './sheet.js';
import type { StateQueryDesk } from './stateQueries.js';
import { resolveTenant, type TenantEnvironment } from './tenants.js';

// → docs/spec/36-remote-validation.md

const SWEPT =
  'the agent dispatched to run it ended without reporting — its transcript says what happened. ' +
  'Nothing was read, so nothing was written on the sheet.';

interface RemoteValidationDeskDeps {
  store: Store;
  environments: readonly EnvironmentConfig[];
  observer: EnvironmentObserver;
  queries: StateQueryDesk;
  probeIntervalMs: number;
  /**
   * `remoteValidation.scriptGraceMs` — how long a one-off script's source outlives the goal's
   * delivery. → docs/spec/36-remote-validation.md#the-one-off-script
   */
  scriptGraceMs: number;
  /**
   * How a captured screen is put in front of somebody who never opens the cockpit. The image half is
   * `Partial` because it is a capability only some providers have — Azure DevOps has an attachment
   * API and GitHub has none — and a caller has a working answer either way.
   * → docs/spec/15-integrations.md#uploading-an-image-to-a-ticket
   */
  sink: ActionSink & Partial<IssueImageSink>;
  /** Where a goal's validation directory is, which is where a capture outlives the run that took it. */
  validationRoot: string;
  /** How a kept capture is read back off disk. Injected so a test lays no image down. */
  readCapture?: (goalRef: string, name: string) => Promise<Buffer>;
  /**
   * How a posted capture's link is built, installed by `buildApp` because minting the capability
   * needs the server's key. Absent — or answering null — the comment still goes up, carrying the
   * prose alone. → docs/spec/36-remote-validation.md#posting-the-screen-to-the-ticket
   */
  captureLink?: CaptureLink;
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

  private captureLink: CaptureLink | null;

  private readonly readCapture: (goalRef: string, name: string) => Promise<Buffer>;

  constructor(private readonly deps: RemoteValidationDeskDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.captureLink = deps.captureLink ?? null;
    this.readCapture =
      deps.readCapture ?? ((goalRef, name) => readFile(validationResourcePath(deps.validationRoot, goalRef, name)));
  }

  /**
   * The server's own capability signer, handed over once the HTTP app exists. It is installed rather
   * than constructed because the artifact key is minted in `buildApp` and the harness is built before
   * it; nothing here is worse for arriving late, because a pulse that runs first simply posts the
   * prose. → docs/spec/36-remote-validation.md#posting-the-screen-to-the-ticket
   *
   * @public the seam `buildApp` hands the capture link to this desk through
   */
  linkCapturesWith(link: CaptureLink): void {
    this.captureLink = link;
  }

  /** @public the pass `Harness.runCycle` runs below `EnvironmentDesk` */
  async run(): Promise<void> {
    if (!this.deps.environments.some((e) => e.validate !== undefined)) return;
    await this.assembleAll();
    await this.postCaptures();
    this.sweep();
    this.sweepScripts();
  }

  /**
   * The screens a run handed back, put on the goal's ticket. A capture is kept precisely because
   * somebody still has to look at it, and a person who never opens the cockpit would otherwise never
   * be told one exists.
   *
   * Three things about it, and each is one this codebase already holds:
   *
   * - **It is never a `WorldEvent`,** an arrival's rule and for an arrival's reason: `deliveryHold`
   *   expires a standing delivery verdict on any world event matching the goal's issue ref, so a
   *   posting written as one would un-park the goal it reported on and hand delivered work back to
   *   the fleet. Its own table, and nothing else reads it.
   * - **The record is written after the comment has gone up, never before.** A posting the tracker
   *   refused and the store recorded is a screen nobody will ever be told about; the failure goes
   *   through `errors.record` and the next pulse is the retry.
   * - **It writes on no check row.** A reading somebody took is theirs, and this pass is about where
   *   an image is shown.
   */
  private async postCaptures(): Promise<void> {
    const { store, errors } = this.deps;
    let postable;
    try {
      postable = postableCaptures({
        readings: store.remoteValidation.listRemoteReadings(),
        rows: store.remoteValidation.listRemoteSheetRows(),
        posted: store.remoteValidation.listPostedCaptures(),
      });
    } catch (err) {
      errors?.record({ source: 'cycle', message: `choosing captures to post failed: ${(err as Error).message}` });
      return;
    }
    for (const capture of postable) {
      const number = issueOriginNumber('root', capture.goalRef);
      if (number === null) continue;
      const attached = await this.attach(number, capture);
      try {
        await this.deps.sink.upsertIssueComment({
          number,
          body: captureComment({
            ...capture,
            attached,
            // The link is the fallback and is not minted where the image itself went up: a reader
            // looking at the screen has no use for a URL that stops verifying at the next restart.
            url: attached === null ? (this.captureLink?.(capture.runId, capture.rowId) ?? null) : null,
          }),
          commentRef: null,
        });
      } catch (err) {
        errors?.record({
          source: 'cycle',
          message:
            `posting the screen captured for ${capture.rowId} on ${capture.environment} to ` +
            `${capture.goalRef} failed: ${(err as Error).message}`,
        });
        continue;
      }
      store.remoteValidation.markCapturePosted(capture);
    }
  }

  /**
   * The screen itself, into the tracker's own store, where the provider has somewhere to put it.
   * Null is *post the prose and a link instead*, and it is the answer in three cases that are not the
   * same but want the same thing: no provider can hold an image, the file could not be read, or the
   * upload failed.
   *
   * **A failure here must never cost the comment.** The posting is the only thing that tells anybody a
   * screen is waiting, so an upload that throws is recorded and falls back — never rethrown into the
   * caller, where it would leave the row unposted and retry the same failing upload every pulse for
   * ever. The comment that follows is a worse answer, not no answer.
   * → docs/spec/36-remote-validation.md#posting-the-screen-to-the-ticket
   */
  private async attach(number: number, capture: PostableCapture): Promise<string | null> {
    const { sink, errors } = this.deps;
    if (sink.canAttachIssueImage?.() !== true || sink.attachIssueImage === undefined) return null;
    try {
      const bytes = await this.readCapture(capture.goalRef, capture.capture);
      const held = await sink.attachIssueImage({ number, fileName: capture.capture, bytes });
      return held.ok ? held.url : null;
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message:
          `attaching the screen captured for ${capture.rowId} on ${capture.environment} to ` +
          `${capture.goalRef} failed: ${(err as Error).message}. The comment still goes up, carrying a link.`,
      });
      return null;
    }
  }

  private async assembleAll(): Promise<void> {
    const { store, errors } = this.deps;
    let considered: { arrival: GoalArrival; assemble: boolean }[];
    try {
      considered = sheetableArrivals({
        arrivals: store.environments.listGoalArrivals(),
        environments: this.deps.environments,
        authored: (goalRef) =>
          checkSetReleased({
            record: store.validation.getValidationPlanRecord(goalRef),
            checks: store.validation.listValidationChecks(goalRef),
          }),
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
        store.environments.markArrivalSheeted(arrival.goalRef, arrival.environment);
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
   * learned nothing about the goal, a `blocked` run's rule.
   */
  private sweep(): void {
    const { store, errors } = this.deps;
    try {
      for (const run of store.remoteValidation.listRemoteRuns()) {
        if (run.status !== 'dispatched' || run.taskId === null) continue;
        const task = store.tasks.getTask(run.taskId);
        if (task === null || isActiveTask(task)) continue;
        store.remoteValidation.endRemoteRun(run.id, { status: 'abandoned', note: SWEPT });
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `the remote validation sweep failed: ${(err as Error).message}`,
      });
    }
  }

  /**
   * The one-off scripts whose goals are long since delivered. A one-off that survives its goal is an
   * unreviewed test nobody maintains and nobody can attribute, failing mysteriously against a product
   * that moved on — a second suite grown by accident, which is the whole reason the source is
   * goal-scoped rather than committed.
   *
   * The clock runs from the goal's **delivery**, which is what parks it: the delivery row is the one
   * moment the harness records as *this goal is over*, and dating the grace from anything the check
   * itself carries would restart it every time somebody recorded a reading on the row.
   *
   * It **names what it removed**, and it names it where the source was: `scriptSweptAt` on the step.
   * A `browser` step that reads *there was a script here and it is gone* is not the same row as one a
   * person always drove, and a sweep that simply nulled the field would rewrite how a green row was
   * earned. Nothing else on the row is touched — the reading, the hand-back and the amendment band
   * are the goal's history and this is housekeeping.
   *
   * Its own `try`, beside the run sweep's and for the same reason: a pass that throws goes through
   * `errors.record` and never fails the cycle or the pass beside it.
   */
  private sweepScripts(): void {
    const { store, errors } = this.deps;
    try {
      const at = new Date(this.now()).toISOString();
      const cutoff = this.now() - this.deps.scriptGraceMs;
      for (const delivery of store.verdicts.listDeliveries()) {
        if (Date.parse(delivery.decidedAt) > cutoff) continue;
        for (const check of store.validation.listValidationChecks(delivery.originRef)) {
          const swept = sweptScripts(check.steps, at);
          if (swept === null) continue;
          store.validation.sweepValidationScripts(delivery.originRef, check.id, swept);
        }
      }
    } catch (err) {
      errors?.record({
        source: 'cycle',
        message: `the one-off script grace sweep failed: ${(err as Error).message}`,
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
    const check = this.deps.store.watches.listGoalWatches().find((c) => c.originRef === originRef && c.id === checkId);
    if (check === undefined) return null;
    const environment = this.deps.environments.find((e) => e.name === environmentName);
    if (environment === undefined) return null;
    const digest = queryDigest(check.query, check.presence ?? '');
    if (!accept) {
      this.deps.store.remoteValidation.declineStateQuery(digest, environment.name);
      return { check, reading: null, approved: false };
    }
    const reading = await this.readWatch(environment, originRef, checkId);
    if (reading === null || reading.outcome === 'blocked') return { check, reading, approved: false };
    this.deps.store.remoteValidation.approveStateQuery({
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
      checks: store.validation.listValidationChecks(goalRef),
      watches: store.watches.listGoalWatches().filter((w) => w.originRef === goalRef),
      queries: store.remoteValidation.listStateQueries().filter((q) => q.originRef === goalRef),
      approvals: new Set(store.remoteValidation.listStateQueryApprovals().map((a) => `${a.digest} ${a.environment}`)),
      // Resolved here rather than in `sheetRows`: the sheet is a pure fold, and where a tenant comes
      // from is a question about stamped rows, the machine's environment and the clock.
      tenant: resolveTenant({
        environment,
        stamped: store.remoteValidation.listRemoteTenants(),
        now: this.now(),
        env: this.deps.env,
      }).standing,
    });
    store.remoteValidation.openRemoteSheet({ goalRef, environment: environment.name });
    store.remoteValidation.saveRemoteSheetRows(
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
    const reading = await this.readRow(environment, goalRef, row.run, row.sourceId);
    if (reading === null) return;
    if (reading.outcome === 'blocked') {
      this.deps.store.remoteValidation.blockRemoteSheetRow(
        goalRef,
        environment.name,
        row.rowId,
        reading.detail ?? 'no reading was taken',
      );
      return;
    }
    this.deps.store.remoteValidation.recordRemoteReading({
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
      // A query hands nothing back to look at. Only a `screenshot` step's row carries a screen, and
      // that only ever arrives through a run's report.
      capture: null,
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
    const query: StateQuery | undefined = this.deps.store.remoteValidation
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

  /**
   * What a sheet's reading of a live watch check is about: this goal's arrival on
   * that environment, which is the same instant the window's own readings are
   * bounded to — so the sheet and the watch answer the same question of the same
   * period, and a sheet run before the work arrived reads the window the run is in.
   */
  private watchSince(environment: EnvironmentConfig, goalRef: string): string {
    const arrivals = this.deps.store.environments
      .listGoalArrivals()
      .filter((a) => a.goalRef === goalRef && a.environment === environment.name);
    const arrived = arrivals[arrivals.length - 1]?.arrivedAt;
    return arrived ?? new Date(this.now() - watchWindowMs(environment)).toISOString();
  }

  private async readWatch(
    environment: EnvironmentConfig,
    goalRef: string,
    checkId: string,
  ): Promise<RowReading | null> {
    const check: GoalWatch | undefined = this.deps.store.watches
      .listGoalWatches()
      .find((c) => c.originRef === goalRef && c.id === checkId);
    if (check === undefined) return null;
    const command = environment.watch?.observe;
    if (command === undefined) return null;
    const since = this.watchSince(environment, goalRef);
    const presence: WatchResult | null =
      check.presence === null
        ? null
        : await this.deps.observer.observe({
            environment: environment.name,
            command,
            checkId: check.id,
            query: check.presence,
            kind: 'presence',
            since,
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
          since,
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
