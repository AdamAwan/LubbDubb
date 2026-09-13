import { createHash, randomUUID } from 'node:crypto';
import type {
  RemoteReading,
  RemoteRun,
  RemoteRunStatus,
  RemoteTenant,
  RemoteRowKind,
  RemoteRowOutcome,
  RemoteSheet,
  RemoteSheetRow,
  StateQuery,
  StateQueryApproval,
  StateQueryAuthor,
  SelectorOffering,
  StateQueryInput,
  WatchReadingVerdict,
} from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

export const REMOTE_VALIDATION_COLUMNS: ColumnMigrations = {
  remote_state_queries: {},
  remote_query_approvals: {},
  remote_sheets: {},
  // What the pre-flight's listing attributes to a check row's area, written before any press is
  // spent. The count comes from the listing and never from a report: derived the other way, a
  // selector that matched nothing reads as a clean pass.
  remote_sheet_rows: { matched: 'INTEGER' },
  // A reading with no commit beside it is a reading of a product nobody can name, so a reading taken
  // through a run carries the commits that run straddled. Both are null on one taken at assembly.
  // What the run's own report said about a browser row, beside the commits it straddled: how many
  // of the matched tests ran, how many retries it took, how long it stood there, and where the
  // artefacts were published. `matched` is **not** here — it is on the sheet row, from the
  // pre-flight's listing, because derived from a report a selector matching nothing reads as a pass.
  remote_readings: {
    started_sha: 'TEXT',
    ended_sha: 'TEXT',
    executed: 'INTEGER',
    retries: 'INTEGER',
    duration_ms: 'INTEGER',
    artefacts: 'TEXT',
  },
  // A run row a dispatched agent reports against: which task claimed it, and where the report and
  // the artefacts landed. Columns on a table that was new one release ago, which is what this entry
  // exists for — without them they are invisible on every database from before they existed.
  remote_runs: { task_id: 'TEXT', report_path: 'TEXT', artefacts: 'TEXT' },
  remote_tenants: {},
  remote_selector_offerings: {},
};

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
            dryRunEnvironment: unchanged ? existing.dry_run_environment : null,
            dryRunAt: unchanged ? existing.dry_run_at : null,
            dryRunVerdict: unchanged ? existing.dry_run_verdict : null,
            dryRunPresence: unchanged ? existing.dry_run_presence : null,
            dryRunRows: unchanged ? existing.dry_run_rows : null,
            dryRunDetail: unchanged ? existing.dry_run_detail : null,
            dryRunSample: unchanged ? existing.dry_run_sample : null,
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
          awaiting_approval, matched, updated_at)
       VALUES (@goalRef, @environment, @rowId, @kind, @seq, @title, @sourceId, @selected, @blockedReason,
          @awaitingApproval, @matched, @now)`,
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
   * What the pre-flight learned about a `check` row before any press was spent on it: how many tests
   * the deployed runner's own listing attributes to the row's area, and why nothing can be learned
   * here where it offers none. The count is written from the listing and from nowhere else.
   */
  recordRemotePreflight(
    goalRef: string,
    environment: string,
    verdicts: readonly { rowId: string; matched: number | null; blockedReason: string | null }[],
  ): void {
    const now = this.ctx.now();
    const write = this.ctx.prep(
      `UPDATE remote_sheet_rows SET matched=@matched, blocked_reason=@blockedReason, updated_at=@now
        WHERE goal_ref=@goalRef AND environment=@environment AND row_id=@rowId`,
    );
    this.ctx.db.transaction(() => {
      for (const verdict of verdicts) write.run({ ...verdict, goalRef, environment, now });
    })();
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
    }));
  }

  /** Append-only. A later reading supersedes the one before it; nothing is deleted. */
  recordRemoteReading(input: Omit<RemoteReading, 'readAt'>): void {
    this.ctx
      .prep(
        `INSERT INTO remote_readings (goal_ref, environment, row_id, run_id, outcome, rows, value, detail,
           started_sha, ended_sha, executed, retries, duration_ms, artefacts, read_at)
         VALUES (@goalRef, @environment, @rowId, @runId, @outcome, @rows, @value, @detail,
           @startedSha, @endedSha, @executed, @retries, @durationMs, @artefacts, @readAt)`,
      )
      .run({ ...input, readAt: this.ctx.now() });
  }

  listRemoteReadings(): RemoteReading[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_readings ORDER BY id ASC`).all() as ReadingRow[];
    return rows.map((r) => ({
      goalRef: r.goal_ref,
      environment: r.environment,
      rowId: r.row_id,
      runId: r.run_id,
      outcome: r.outcome as RemoteRowOutcome,
      rows: r.rows,
      value: r.value,
      detail: r.detail,
      startedSha: r.started_sha ?? null,
      endedSha: r.ended_sha ?? null,
      executed: r.executed ?? null,
      retries: r.retries ?? null,
      durationMs: r.duration_ms ?? null,
      artefacts: r.artefacts ?? null,
      readAt: r.read_at,
    }));
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

  listRemoteTenants(): RemoteTenant[] {
    const rows = this.ctx.prep(`SELECT * FROM remote_tenants ORDER BY environment, tenant`).all() as TenantRow[];
    return rows.map((r) => ({
      environment: r.environment,
      tenant: r.tenant,
      ensuredAt: r.ensured_at,
      reseededAt: r.reseeded_at,
    }));
  }

  /**
   * What one environment's runner last said it offers, replacing that environment's offering whole.
   * Only an **answered** listing reaches here: a listing that could not say leaves the last one
   * standing rather than emptying the offering, because an empty offering read as an answer is a
   * planner told this deployment has no areas at all.
   */
  recordSelectorOffering(
    environment: string,
    offers: readonly { selector: string; tests: number | null }[],
    listedAt?: string,
  ): void {
    // The desk's own clock, not the store's: the refresh throttle reads `listed_at` back against the
    // clock it was written from, and two clocks make an interval that never elapses or always does.
    const now = listedAt ?? this.ctx.now();
    const insert = this.ctx.prep(
      `INSERT OR REPLACE INTO remote_selector_offerings (environment, selector, tests, listed_at)
       VALUES (@environment, @selector, @tests, @now)`,
    );
    this.ctx.db.transaction(() => {
      this.ctx.prep(`DELETE FROM remote_selector_offerings WHERE environment=?`).run(environment);
      for (const offer of offers) insert.run({ environment, selector: offer.selector, tests: offer.tests, now });
    })();
  }

  listSelectorOfferings(): SelectorOffering[] {
    const rows = this.ctx
      .prep(`SELECT * FROM remote_selector_offerings ORDER BY environment, selector`)
      .all() as SelectorOfferingRow[];
    return rows.map((r) => ({
      environment: r.environment,
      selector: r.selector,
      tests: r.tests ?? null,
      listedAt: r.listed_at,
    }));
  }

  /**
   * Every area any browser environment's runner offers, de-duplicated. The set a `coverage` is
   * refused against at plan submission, and the reason the refusal is a convenience rather than an
   * authority: it is what a listing last said, and the pre-flight asks again at assembly.
   */
  listOfferedAreas(): string[] {
    const rows = this.ctx.prep(`SELECT DISTINCT selector FROM remote_selector_offerings ORDER BY selector`).all() as {
      selector: string;
    }[];
    return rows.map((r) => r.selector);
  }

  private nextSeq(originRef: string): number {
    const { top } = this.ctx
      .prep(`SELECT MAX(seq) AS top FROM remote_state_queries WHERE goal_ref=?`)
      .get(originRef) as { top: number | null };
    return (top ?? 0) + 1;
  }
}

interface SelectorOfferingRow {
  environment: string;
  selector: string;
  tests: number | null;
  listed_at: string;
}

interface StateQueryRow {
  goal_ref: string;
  query_id: string;
  seq: number;
  title: string;
  query: string;
  presence: string;
  why: string | null;
  digest: string;
  authored: string;
  dry_run_environment: string | null;
  dry_run_at: string | null;
  dry_run_verdict: string | null;
  dry_run_presence: string | null;
  dry_run_rows: number | null;
  dry_run_detail: string | null;
  dry_run_sample: string | null;
  created_at: string;
  updated_at: string;
}

interface SheetRow {
  goal_ref: string;
  environment: string;
  assembled_at: string;
}

interface SheetRowRow {
  goal_ref: string;
  environment: string;
  row_id: string;
  kind: string;
  seq: number;
  title: string;
  source_id: string;
  selected: number;
  blocked_reason: string | null;
  awaiting_approval: number;
  matched: number | null | undefined;
  updated_at: string;
}

interface ReadingRow {
  goal_ref: string;
  environment: string;
  row_id: string;
  run_id: string | null;
  outcome: string;
  rows: number | null;
  value: number | null;
  detail: string | null;
  started_sha: string | null;
  ended_sha: string | null;
  executed: number | null | undefined;
  retries: number | null | undefined;
  duration_ms: number | null | undefined;
  artefacts: string | null | undefined;
  read_at: string;
}

interface RunRow {
  id: string;
  goal_ref: string;
  environment: string;
  tenant: string;
  status: string;
  started_sha: string | null;
  ended_sha: string | null;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  task_id: string | null | undefined;
  report_path: string | null | undefined;
  artefacts: string | null | undefined;
}

interface TenantRow {
  environment: string;
  tenant: string;
  ensured_at: string | null;
  reseeded_at: string | null;
}

const RUN_STATUSES: RemoteRunStatus[] = ['pending', 'dispatched', 'ended', 'abandoned'];

function toRemoteRun(row: RunRow): RemoteRun {
  return {
    id: row.id,
    goalRef: row.goal_ref,
    environment: row.environment,
    tenant: row.tenant,
    status: RUN_STATUSES.includes(row.status as RemoteRunStatus) ? (row.status as RemoteRunStatus) : 'abandoned',
    startedSha: row.started_sha,
    endedSha: row.ended_sha,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    note: row.note,
    taskId: row.task_id ?? null,
    reportPath: row.report_path ?? null,
    artefacts: row.artefacts ?? null,
  };
}

interface ApprovalRow {
  query_digest: string;
  environment: string;
  goal_ref: string;
  query_id: string;
  approved_at: string;
  approved_rows: number | null;
  approved_detail: string | null;
}

function hydrate(row: StateQueryRow): StateQuery {
  return {
    originRef: row.goal_ref,
    id: row.query_id,
    seq: row.seq,
    title: row.title,
    query: row.query,
    presence: row.presence,
    why: row.why,
    digest: row.digest,
    authored: row.authored as StateQueryAuthor,
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict as WatchReadingVerdict | null,
    dryRunPresence: row.dry_run_presence as WatchReadingVerdict | null,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
    dryRunSample: row.dry_run_sample,
  };
}
