import { createHash, randomUUID } from 'node:crypto';
import type {
  RemoteCapturePost,
  RemoteReading,
  RemoteRun,
  RemoteRunStatus,
  RemoteTenant,
  RemoteRowKind,
  RemoteSheet,
  RemoteSheetRow,
  StateQuery,
  StateQueryApproval,
  StateQueryAuthor,
  StateQueryInput,
  TenantCall,
  TenantLaunch,
  TenantPreparation,
  WatchReadingVerdict,
} from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';
import {
  hydrate,
  keptDryRun,
  launchOf,
  toRemoteReading,
  toRemoteRun,
  toTenantPreparation,
  type ApprovalRow,
  type CapturePostRow,
  type PrepareRow,
  type ReadingRow,
  type RunRow,
  type SheetRow,
  type SheetRowRow,
  type StateQueryRow,
  type TenantRow,
} from './rows/remoteValidation.js';

// → docs/spec/14-persistence.md

export const REMOTE_VALIDATION_COLUMNS: ColumnMigrations = {
  remote_state_queries: {},
  remote_query_approvals: {},
  remote_sheets: {},
  // What the pre-flight's listing attributes to a check row's area, written before any press is
  // spent. The count comes from the listing and never from a report: derived the other way, a
  // selector that matched nothing reads as a clean pass.
  // What the run's listing attributes to a check row's area, and why a press reads nothing here.
  // `idle_reason` is null on every row written before it, which reads as *a press reads this row* —
  // the reading those rows already had — and nothing recomputes it at boot: it is folded where the
  // sheet is assembled, by `sheetRows`, and a boot pass that worked it out again would be a second
  // author for a sentence one fold already owns.
  remote_sheet_rows: { matched: 'INTEGER', idle_reason: 'TEXT' },
  // A reading with no commit beside it is a reading of a product nobody can name, so a reading taken
  // through a run carries the commits that run straddled. Both are null on one taken at assembly.
  // What the run's own report said about a browser row, beside the commits it straddled: how many
  // of the matched tests ran, how many retries it took, how long it stood there, and where the
  // artefacts were published. `matched` is **not** here — it is on the sheet row, from the
  // pre-flight's listing, because derived from a report a selector matching nothing reads as a pass.
  // `capture` is the file name of the screen this row handed back, held with the goal. Null is *no
  // screen*, which is true of every row from before the column and stays true — there is nothing to
  // compute it from, so nothing is backfilled.
  remote_readings: {
    started_sha: 'TEXT',
    ended_sha: 'TEXT',
    executed: 'INTEGER',
    retries: 'INTEGER',
    duration_ms: 'INTEGER',
    artefacts: 'TEXT',
    capture: 'TEXT',
  },
  // A run row a dispatched agent reports against: which task claimed it, and where the report and
  // the artefacts landed. Columns on a table that was new one release ago, which is what this entry
  // exists for — without them they are invisible on every database from before they existed.
  // Where the run agent said the runner's own selector listing landed. No backfill: null means *no
  // listing was reported on this run*, which is true of every run written before the column and
  // stays true — there is nothing to compute it from and nothing that would be right to invent.
  remote_runs: { task_id: 'TEXT', report_path: 'TEXT', artefacts: 'TEXT', listing_path: 'TEXT' },
  remote_tenants: {},
  // Which command a preparation is running and the runner holding it, so a restart can find the
  // command again rather than close a row whose process is still going. Null on a row from before the
  // columns, and on one whose command never launched: no process to find, so boot closes it as it
  // always did. → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
  remote_tenant_prepares: { call: 'TEXT', launch_id: 'TEXT', pid: 'INTEGER', launched_at: 'TEXT' },
  remote_capture_posts: {},
};

/**
 * The offering cache. Nothing pre-resolves an area at plan time any more — a `suite` step's area is
 * resolved against the deployed commit's own listing when the run happens — so the table it was kept
 * in is dropped rather than left to be read by something later. Its `CREATE TABLE IF NOT EXISTS` is
 * gone from the schema in the same change: `rebuildTables` re-runs the schema immediately after the
 * drop, so a `CREATE` left standing recreates the table empty on every boot, invisibly.
 * → docs/spec/14-persistence.md
 */
export const REMOTE_VALIDATION_RETIRED_TABLES: readonly string[] = ['remote_selector_offerings'];

/**
 * A press opens a run here, and the dispatch flip claims it. Both are live: the `(environment,
 * tenant)` lock holds over the pair, and the partial unique index behind it names both.
 */
const OPEN_RUN: RemoteRunStatus = 'pending';
const CLAIMED_RUN: RemoteRunStatus = 'dispatched';
const LIVE_RUN_SQL = `('${OPEN_RUN}', '${CLAIMED_RUN}')`;

/**
 * What an operator has read and consented to: a query's text and its presence query together, so
 * `presence` is approved on exactly the terms the query it belongs to is.
 */
export function queryDigest(query: string, presence: string): string {
  return createHash('sha256').update(`${query}\x00${presence}`).digest('hex').slice(0, 32);
}

interface StateQueryDryRun {
  environment: string;
  verdict: WatchReadingVerdict;
  presence: WatchReadingVerdict | null;
  rows: number | null;
  detail: string | null;
  sample: string | null;
}

export class RemoteValidationStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Merge-only on the slug: a query not named is left exactly as it is, and nothing is withdrawn. An
   * operator's own row is neither swept nor overwritten by a replan. Where the text changed, every
   * approval of the old digest is dropped — an edited query is a new question everywhere, and an edit
   * and an edit back must not resurface a consent nobody re-gave.
   */
  saveStateQueries(originRef: string, queries: readonly StateQueryInput[], authored: StateQueryAuthor): string[] {
    const now = this.ctx.now();
    return this.ctx.db.transaction(() => {
      const saved: string[] = [];
      for (const query of queries) {
        const existing = this.ctx
          .prep(`SELECT * FROM remote_state_queries WHERE goal_ref=? AND query_id=?`)
          .get(originRef, query.id) as StateQueryRow | undefined;
        if (existing !== undefined && existing.authored === 'operator' && authored !== 'operator') continue;
        const digest = queryDigest(query.query, query.presence);
        const unchanged = existing !== undefined && existing.digest === digest;
        if (existing !== undefined && !unchanged)
          this.ctx.prep(`DELETE FROM remote_query_approvals WHERE query_digest=?`).run(existing.digest);
        this.ctx
          .prep(
            `INSERT OR REPLACE INTO remote_state_queries
               (goal_ref, query_id, seq, title, query, presence, why, digest, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows,
                dry_run_detail, dry_run_sample, created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @title, @query, @presence, @why, @digest, @authored,
                @dryRunEnvironment, @dryRunAt, @dryRunVerdict, @dryRunPresence, @dryRunRows,
                @dryRunDetail, @dryRunSample, @createdAt, @now)`,
          )
          .run({
            ...query,
            seq: existing?.seq ?? this.nextSeq(originRef),
            digest,
            authored: existing?.authored ?? authored,
            ...keptDryRun(unchanged ? existing : null),
            createdAt: existing?.created_at ?? now,
            goalRef: originRef,
            now,
          });
        saved.push(query.id);
      }
      return saved;
    })();
  }

  listStateQueries(): StateQuery[] {
    return (this.ctx.prep(`SELECT * FROM remote_state_queries ORDER BY goal_ref, seq`).all() as StateQueryRow[]).map(
      hydrate,
    );
  }

  deleteStateQuery(originRef: string, queryId: string): boolean {
    return this.ctx.db.transaction(() => {
      const row = this.ctx
        .prep(`SELECT digest FROM remote_state_queries WHERE goal_ref=? AND query_id=?`)
        .get(originRef, queryId) as { digest: string } | undefined;
      if (row === undefined) return false;
      this.ctx.prep(`DELETE FROM remote_state_queries WHERE goal_ref=? AND query_id=?`).run(originRef, queryId);
      this.ctx.prep(`DELETE FROM remote_query_approvals WHERE query_digest=?`).run(row.digest);
      return true;
    })();
  }

  recordStateQueryDryRun(originRef: string, queryId: string, reading: StateQueryDryRun): void {
    this.ctx
      .prep(
        `UPDATE remote_state_queries
            SET dry_run_environment=@environment, dry_run_at=@now, dry_run_verdict=@verdict,
                dry_run_presence=@presence, dry_run_rows=@rows, dry_run_detail=@detail,
                dry_run_sample=@sample, updated_at=@now
          WHERE goal_ref=@goalRef AND query_id=@queryId`,
      )
      .run({ ...reading, goalRef: originRef, queryId, now: this.ctx.now() });
  }

  /**
   * Keyed on the digest and the environment rather than the digest alone: "I have read this and it is
   * safe here" is a statement about a place as much as about a query.
   */
  approveStateQuery(input: Omit<StateQueryApproval, 'approvedAt'>): void {
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO remote_query_approvals
           (query_digest, environment, goal_ref, query_id, approved_at, approved_rows, approved_detail)
         VALUES (@digest, @environment, @originRef, @queryId, @now, @rows, @detail)`,
      )
      .run({ ...input, now: this.ctx.now() });
  }

  declineStateQuery(digest: string, environment: string): void {
    this.ctx.prep(`DELETE FROM remote_query_approvals WHERE query_digest=? AND environment=?`).run(digest, environment);
  }

  listStateQueryApprovals(): StateQueryApproval[] {
    const rows = this.ctx
      .prep(`SELECT * FROM remote_query_approvals ORDER BY approved_at ASC, environment ASC`)
      .all() as ApprovalRow[];
    return rows.map((row) => ({
      digest: row.query_digest,
      environment: row.environment,
      originRef: row.goal_ref,
      queryId: row.query_id,
      approvedAt: row.approved_at,
      rows: row.approved_rows,
      detail: row.approved_detail,
    }));
  }

  /**
   * OR IGNORE: a second arrival re-runs the sheet that exists rather than opening a second one, and
   * the original `assembled_at` is what the sheet is dated by.
   */
  openRemoteSheet(input: { goalRef: string; environment: string }): void {
    this.ctx
      .prep(
        `INSERT OR IGNORE INTO remote_sheets (goal_ref, environment, assembled_at)
         VALUES (@goalRef, @environment, @assembledAt)`,
      )
      .run({ ...input, assembledAt: this.ctx.now() });
  }

  listRemoteSheets(): RemoteSheet[] {
    const rows = this.ctx
      .prep(`SELECT * FROM remote_sheets ORDER BY assembled_at DESC, environment ASC`)
      .all() as SheetRow[];
    return rows.map((r) => ({ goalRef: r.goal_ref, environment: r.environment, assembledAt: r.assembled_at }));
  }

  saveRemoteSheetRows(
    goalRef: string,
    environment: string,
    rows: readonly Omit<RemoteSheetRow, 'goalRef' | 'environment'>[],
  ): void {
    const now = this.ctx.now();
    const write = this.ctx.prep(
      `INSERT OR REPLACE INTO remote_sheet_rows
         (goal_ref, environment, row_id, kind, seq, title, source_id, selected, blocked_reason,
          awaiting_approval, matched, idle_reason, updated_at)
       VALUES (@goalRef, @environment, @rowId, @kind, @seq, @title, @sourceId, @selected, @blockedReason,
          @awaitingApproval, @matched, @idleReason, @now)`,
    );
    this.ctx.db.transaction(() => {
      for (const row of rows)
        write.run({
          ...row,
          goalRef,
          environment,
          selected: row.selected ? 1 : 0,
          awaitingApproval: row.awaitingApproval ? 1 : 0,
          now,
        });
    })();
  }

  /**
   * What the run's own listing attributes to a `check` row's area, and **nothing else on the row**.
   * A reason the listing found is a `blocked` reading against the run, never a `blocked_reason`: a
   * reason on the row is a cause no press can overcome, and a mismatch a listing found is amendable.
   */
  recordRemoteMatched(
    goalRef: string,
    environment: string,
    verdicts: readonly { rowId: string; matched: number | null }[],
  ): void {
    const now = this.ctx.now();
    const write = this.ctx.prep(
      `UPDATE remote_sheet_rows SET matched=@matched, updated_at=@now
        WHERE goal_ref=@goalRef AND environment=@environment AND row_id=@rowId`,
    );
    this.ctx.db.transaction(() => {
      for (const verdict of verdicts) write.run({ ...verdict, goalRef, environment, now });
    })();
  }

  /** Where the run agent said the runner's own listing landed. A path, and never what is in it. */
  recordRemoteListingPath(id: string, listingPath: string): void {
    this.ctx.prep(`UPDATE remote_runs SET listing_path=? WHERE id=?`).run(listingPath, id);
  }

  blockRemoteSheetRow(goalRef: string, environment: string, rowId: string, reason: string): void {
    this.ctx
      .prep(
        `UPDATE remote_sheet_rows SET blocked_reason=?, updated_at=? WHERE goal_ref=? AND environment=? AND row_id=?`,
      )
      .run(reason, this.ctx.now(), goalRef, environment, rowId);
  }

  listRemoteSheetRows(): RemoteSheetRow[] {
    const rows = this.ctx
      .prep(`SELECT * FROM remote_sheet_rows ORDER BY goal_ref, environment, seq, row_id`)
      .all() as SheetRowRow[];
    return rows.map((r) => ({
      goalRef: r.goal_ref,
      environment: r.environment,
      rowId: r.row_id,
      kind: r.kind as RemoteRowKind,
      seq: r.seq,
      title: r.title,
      sourceId: r.source_id,
      selected: r.selected === 1,
      blockedReason: r.blocked_reason,
      awaitingApproval: r.awaiting_approval === 1,
      matched: r.matched ?? null,
      idleReason: r.idle_reason ?? null,
    }));
  }

  /** Append-only. A later reading supersedes the one before it; nothing is deleted. */
  recordRemoteReading(input: Omit<RemoteReading, 'readAt'>): void {
    this.ctx
      .prep(
        `INSERT INTO remote_readings (goal_ref, environment, row_id, run_id, outcome, rows, value, detail,
           started_sha, ended_sha, executed, retries, duration_ms, artefacts, capture, read_at)
         VALUES (@goalRef, @environment, @rowId, @runId, @outcome, @rows, @value, @detail,
           @startedSha, @endedSha, @executed, @retries, @durationMs, @artefacts, @capture, @readAt)`,
      )
      .run({ ...input, readAt: this.ctx.now() });
  }

  listRemoteReadings(): RemoteReading[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_readings ORDER BY id ASC`).all() as ReadingRow[];
    return rows.map(toRemoteReading);
  }

  /**
   * The latest reading a run took on one row. It is the capture route's whole lookup: the file
   * **name** is read off the row rather than taken from the caller, `/validation-captures`' rule and
   * for its reason — the goal's validation directory also holds its resources, and a route that took
   * a name would serve any of them.
   *
   * @public the seam `GET /validation-captures/run/:runId/:rowId` resolves a sheet-kept capture through
   */
  getRemoteReading(runId: string, rowId: string): RemoteReading | null {
    const row = this.ctx
      .prep(`SELECT * FROM remote_readings WHERE run_id=? AND row_id=? ORDER BY id DESC LIMIT 1`)
      .get(runId, rowId) as ReadingRow | undefined;
    return row === undefined ? null : toRemoteReading(row);
  }

  /**
   * Which captures have already been posted to a goal's ticket. The record is the idempotence, and
   * it is a record rather than anything read back off the tracker: a re-read that posted the same
   * screen a second time is worse than one never posted.
   */
  listPostedCaptures(): RemoteCapturePost[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_capture_posts ORDER BY posted_at ASC`).all() as CapturePostRow[];
    return rows.map((r) => ({
      runId: r.run_id,
      rowId: r.row_id,
      goalRef: r.goal_ref,
      capture: r.capture,
      postedAt: r.posted_at,
    }));
  }

  /**
   * Written **after** the comment has gone up, never before: a posting the tracker refused and the
   * store recorded is a screen nobody will ever be told about, and the next pulse is the retry.
   */
  markCapturePosted(input: { runId: string; rowId: string; goalRef: string; capture: string }): void {
    this.ctx
      .prep(
        `INSERT OR IGNORE INTO remote_capture_posts (run_id, row_id, goal_ref, capture, posted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.runId, input.rowId, input.goalRef, input.capture, this.ctx.now());
  }

  /**
   * The mutual exclusion is this conditional insert **inside** the transaction, `beginLocalRun`'s
   * shape, and never a check the caller is trusted to make first. Two concurrent presses against one
   * `(environment, tenant)` yield one run; two presses against two tenants on one environment yield
   * two, which is what keeps a second operator's readings from overwriting the first's silently.
   */
  beginRemoteRun(input: { goalRef: string; environment: string; tenant: string; startedSha: string | null }): {
    run: RemoteRun | null;
    live: RemoteRun | null;
  } {
    return this.ctx.db.transaction(() => {
      const held = this.ctx
        .prep(`SELECT * FROM remote_runs WHERE environment=? AND tenant=? AND status IN ${LIVE_RUN_SQL} LIMIT 1`)
        .get(input.environment, input.tenant) as RunRow | undefined;
      if (held !== undefined) return { run: null, live: toRemoteRun(held) };
      const run: RemoteRun = {
        id: randomUUID(),
        goalRef: input.goalRef,
        environment: input.environment,
        tenant: input.tenant,
        status: OPEN_RUN,
        startedSha: input.startedSha,
        endedSha: null,
        startedAt: this.ctx.now(),
        endedAt: null,
        note: null,
        taskId: null,
        reportPath: null,
        listingPath: null,
        artefacts: null,
      };
      this.ctx
        .prep(
          `INSERT INTO remote_runs (id, goal_ref, environment, tenant, status, started_sha, ended_sha,
             started_at, ended_at, note, task_id, report_path, artefacts)
           VALUES (@id, @goalRef, @environment, @tenant, @status, @startedSha, NULL, @startedAt,
             NULL, NULL, NULL, NULL, NULL)`,
        )
        .run({
          id: run.id,
          goalRef: run.goalRef,
          environment: run.environment,
          tenant: run.tenant,
          status: run.status,
          startedSha: run.startedSha,
          startedAt: run.startedAt,
        });
      return { run, live: null };
    })();
  }

  /**
   * Ended rather than deleted, `local_validations`' rule: a run abandoned because the environment
   * went back past the goal's work is the case an operator actually hits, and its reason has to be
   * readable afterwards.
   */
  endRemoteRun(
    id: string,
    result: {
      status: Extract<RemoteRunStatus, 'ended' | 'abandoned'>;
      endedSha?: string | null;
      note?: string | null;
      reportPath?: string | null;
      artefacts?: string | null;
    },
  ): RemoteRun | null {
    const info = this.ctx
      .prep(
        `UPDATE remote_runs SET status=@status, ended_sha=COALESCE(@endedSha, ended_sha),
            note=COALESCE(@note, note), report_path=COALESCE(@reportPath, report_path),
            artefacts=COALESCE(@artefacts, artefacts), ended_at=@now
          WHERE id=@id AND status IN ${LIVE_RUN_SQL}`,
      )
      .run({
        id,
        status: result.status,
        endedSha: result.endedSha ?? null,
        note: result.note ?? null,
        reportPath: result.reportPath ?? null,
        artefacts: result.artefacts ?? null,
        now: this.ctx.now(),
      });
    return info.changes === 0 ? null : this.getRemoteRun(id);
  }

  /**
   * The dispatched flip, and the whole of what makes **one agent per run** true across a restart: a
   * conditional `UPDATE ... WHERE status = 'pending'` inside the transaction, `beginRemoteRun`'s
   * discipline, never a check the caller is trusted to make first. A second dispatch onto a run
   * something already claimed changes no row and is told so.
   */
  claimRemoteRun(id: string, taskId: string): RemoteRun | null {
    return this.ctx.db.transaction(() => {
      const info = this.ctx
        .prep(`UPDATE remote_runs SET status=?, task_id=? WHERE id=? AND status=?`)
        .run(CLAIMED_RUN, taskId, id, OPEN_RUN);
      return info.changes === 0 ? null : this.getRemoteRun(id);
    })();
  }

  /**
   * The run's closing commit, written onto every reading it took. A reading with no commit beside it
   * is a reading of a product nobody can name, and only the end of the run knows what the second one
   * was — nothing is deleted or rewritten but this one attribution.
   */
  attributeRemoteReadings(runId: string, endedSha: string | null): void {
    this.ctx.prep(`UPDATE remote_readings SET ended_sha=? WHERE run_id=?`).run(endedSha, runId);
  }

  getRemoteRun(id: string): RemoteRun | null {
    const row = this.ctx.prep(`SELECT * FROM remote_runs WHERE id=?`).get(id) as RunRow | undefined;
    return row === undefined ? null : toRemoteRun(row);
  }

  liveRemoteRun(environment: string, tenant: string): RemoteRun | null {
    const row = this.ctx
      .prep(`SELECT * FROM remote_runs WHERE environment=? AND tenant=? AND status IN ${LIVE_RUN_SQL} LIMIT 1`)
      .get(environment, tenant) as RunRow | undefined;
    return row === undefined ? null : toRemoteRun(row);
  }

  listRemoteRuns(): RemoteRun[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_runs ORDER BY started_at ASC`).all() as RunRow[];
    return rows.map(toRemoteRun);
  }

  /** `{selected}` from the sheet's own control — a row that does not apply here, or that a person will do by hand. */
  setRemoteSheetRowSelected(goalRef: string, environment: string, rowId: string, selected: boolean): boolean {
    const info = this.ctx
      .prep(`UPDATE remote_sheet_rows SET selected=?, updated_at=? WHERE goal_ref=? AND environment=? AND row_id=?`)
      .run(selected ? 1 : 0, this.ctx.now(), goalRef, environment, rowId);
    return info.changes > 0;
  }

  /** The name is always the project's own — nothing here generates or infers a tenant identifier. */
  stampRemoteTenant(input: { environment: string; tenant: string; ensured?: boolean; reseeded?: boolean }): void {
    const now = this.ctx.now();
    const existing = this.ctx
      .prep(`SELECT * FROM remote_tenants WHERE environment=? AND tenant=?`)
      .get(input.environment, input.tenant) as TenantRow | undefined;
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO remote_tenants (environment, tenant, ensured_at, reseeded_at)
         VALUES (@environment, @tenant, @ensuredAt, @reseededAt)`,
      )
      .run({
        environment: input.environment,
        tenant: input.tenant,
        ensuredAt: input.ensured === true ? now : (existing?.ensured_at ?? null),
        reseededAt: input.reseeded === true ? now : (existing?.reseeded_at ?? null),
      });
  }

  /**
   * Opens the record an operator reads while the environment's own tenant commands run. Returns null
   * where one is already in flight for this environment: two reseeds of one tenant at once is the
   * clash the record exists to refuse, and the second press must be told so rather than queued behind
   * a command it cannot see. → docs/spec/36-remote-validation.md#what-the-gate-shows-while-it-runs
   */
  beginTenantPrepare(environment: string): TenantPreparation | null {
    const open = this.tenantPrepare(environment);
    if (open !== null && open.finishedAt === null) return null;
    const startedAt = this.ctx.now();
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO remote_tenant_prepares
           (environment, tenant, started_at, finished_at, ok, detail, call, launch_id, pid, launched_at)
         VALUES (?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(environment, startedAt);
    return {
      environment,
      tenant: null,
      startedAt,
      finishedAt: null,
      ok: null,
      detail: null,
      call: null,
      launchedAt: null,
    };
  }

  /** The command an open preparation has just launched, and the runner a restart will look for. */
  recordTenantLaunch(environment: string, call: TenantCall, launch: TenantLaunch): void {
    this.ctx
      .prep(
        `UPDATE remote_tenant_prepares SET call=?, launch_id=?, pid=?, launched_at=?
           WHERE environment=? AND finished_at IS NULL`,
      )
      .run(call, launch.id, launch.pid, launch.startedAt, environment);
  }

  /** The launch behind an environment's preparation, running or last run. Null where none launched. */
  tenantLaunch(environment: string): { call: TenantCall; launch: TenantLaunch } | null {
    const row = this.ctx.prep(`SELECT * FROM remote_tenant_prepares WHERE environment=?`).get(environment) as
      | PrepareRow
      | undefined;
    return row === undefined ? null : launchOf(row);
  }

  /** Every preparation still open, with the launch a restart has to find — null where none was recorded. */
  openTenantPrepares(): { environment: string; launched: { call: TenantCall; launch: TenantLaunch } | null }[] {
    const rows = this.ctx
      .prep(`SELECT * FROM remote_tenant_prepares WHERE finished_at IS NULL ORDER BY environment`)
      .all() as PrepareRow[];
    return rows.map((row) => ({ environment: row.environment, launched: launchOf(row) }));
  }

  /** What the commands came back as, in the words the operator is told. Null `ok` is *not knowable from here*. */
  finishTenantPrepare(input: { environment: string; tenant: string | null; ok: boolean | null; detail: string }): void {
    this.ctx
      .prep(
        `UPDATE remote_tenant_prepares SET tenant=?, finished_at=?, ok=?, detail=? WHERE environment=? AND finished_at IS NULL`,
      )
      .run(input.tenant, this.ctx.now(), input.ok === null ? null : input.ok ? 1 : 0, input.detail, input.environment);
  }

  /**
   * A preparation whose command is gone and left no outcome. It ran on somebody else's machine, so
   * whether it finished is **not knowable from here** — which is what the row is closed saying. Left
   * open instead, the gate draws a reseed that has been running since last week and refuses every
   * later press.
   */
  closeOrphanedTenantPrepare(environment: string): void {
    this.ctx
      .prep(
        `UPDATE remote_tenant_prepares SET finished_at=?, ok=NULL,
           detail='The harness restarted while this was running, and the command is no longer running. Whether it finished is not known from here — read its output and the tenant''s age, or run it again.'
         WHERE environment=? AND finished_at IS NULL`,
      )
      .run(this.ctx.now(), environment);
  }

  listTenantPrepares(): TenantPreparation[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_tenant_prepares ORDER BY environment`).all() as PrepareRow[];
    return rows.map(toTenantPreparation);
  }

  private tenantPrepare(environment: string): TenantPreparation | null {
    const row = this.ctx.prep(`SELECT * FROM remote_tenant_prepares WHERE environment=?`).get(environment) as
      | PrepareRow
      | undefined;
    return row === undefined ? null : toTenantPreparation(row);
  }

  listRemoteTenants(): RemoteTenant[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_tenants ORDER BY environment, tenant`).all() as TenantRow[];
    return rows.map((r) => ({
      environment: r.environment,
      tenant: r.tenant,
      ensuredAt: r.ensured_at,
      reseededAt: r.reseeded_at,
    }));
  }

  private nextSeq(originRef: string): number {
    const { top } = this.ctx
      .prep(`SELECT MAX(seq) AS top FROM remote_state_queries WHERE goal_ref=?`)
      .get(originRef) as { top: number | null };
    return (top ?? 0) + 1;
  }
}
