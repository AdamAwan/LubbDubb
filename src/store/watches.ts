import type {
  GoalWatch,
  GoalWatchInput,
  GoalWatchProposal,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchPlanRecord,
  WatchWindow,
} from '../types.js';
import type Database from 'better-sqlite3';
import type { StoreContext } from './context.js';
import {
  hydrate,
  hydratePlan,
  hydrateWindow,
  keptAnswers,
  type GoalWatchRow,
  type WatchPlanRow,
  type WatchReadingRow,
  type WatchWindowRow,
} from './rows/watches.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

export const WATCH_COLUMNS: ColumnMigrations = {
  goal_watches: {
    expect_under: 'REAL',
    expect_over: 'REAL',
    expect_baseline: 'INTEGER NOT NULL DEFAULT 0',
    unit: 'TEXT',
    baseline_value: 'REAL',
    baseline_at: 'TEXT',
    live: 'INTEGER NOT NULL DEFAULT 1',
    proposal: 'TEXT',
    authored: "TEXT NOT NULL DEFAULT 'plan'",
    source: 'TEXT',
    changed_from_hint: 'TEXT',
  },
  watch_readings: { value: 'REAL' },
  watch_windows: { extended_at: 'TEXT', exposed_at: 'TEXT' },
  watch_plans: {},
};

/**
 * Every goal already carrying live checks when `watch_plans` is created was authorised under the plan
 * approval that preceded it. Null `authored_at` is *owed*, so without this every such goal would
 * read owed, dispatch an assessor and hold its next arrival. Run only on the boot that creates the
 * table: a pass on every boot would stamp the watch an operator is being asked about right now.
 * → docs/spec/14-persistence.md#when-a-null-means-something
 */
export function stampWatchPlansFromBeforeTheAssessor(db: Database.Database, now: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO watch_plans (goal_ref, authored_at, note, empty_reason, accepted_at, sent_back_at,
                                        sent_back_words, updated_at)
     SELECT DISTINCT goal_ref, @now, NULL, NULL, @now, NULL, NULL, @now FROM goal_watches WHERE live=1`,
  ).run({ now });
}

export class WatchStore {
  constructor(private readonly ctx: StoreContext) {}

  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    this.ctx.db.transaction(() => {
      const keep = new Set(checks.map((c) => c.id));
      const mine = new Set<string>();
      for (const row of this.ctx
        .prep(`SELECT check_id, authored, live FROM goal_watches WHERE goal_ref=?`)
        .all(originRef) as {
        check_id: string;
        authored: string;
        live: number;
      }[]) {
        if (row.authored === 'operator' || row.authored === 'assessor') {
          mine.add(row.check_id);
          continue;
        }
        if (row.live === 0 || keep.has(row.check_id)) continue;
        this.ctx.prep(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
        this.ctx.prep(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
      }
      for (const check of checks) {
        if (mine.has(check.id)) continue;
        this.ctx
          .prep(
            `INSERT OR REPLACE INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why, source,
                baseline_value, baseline_at, live, proposal, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source,
                NULL, NULL, 1, NULL, 'plan',
                NULL, NULL, NULL, NULL, NULL, NULL, @now, @now)`,
          )
          .run({ ...check, expectBaseline: check.expectBaseline ? 1 : 0, goalRef: originRef, now: this.ctx.now() });
      }
    })();
  }

  recordWatchDryRun(
    originRef: string,
    checkId: string,
    reading: {
      environment: string;
      verdict: WatchReadingVerdict;
      presence: WatchReadingVerdict | null;
      rows: number | null;
      detail: string | null;
      value: number | null;
    },
  ): void {
    this.ctx
      .prep(
        `UPDATE goal_watches
            SET dry_run_environment=@environment, dry_run_at=@now, dry_run_verdict=@verdict,
                dry_run_presence=@presence, dry_run_rows=@rows, dry_run_detail=@detail,
                baseline_value=COALESCE(@value, baseline_value),
                baseline_at=CASE WHEN @value IS NULL THEN baseline_at ELSE @now END,
                updated_at=@now
          WHERE goal_ref=@goalRef AND check_id=@checkId`,
      )
      .run({ ...reading, goalRef: originRef, checkId, now: this.ctx.now() });
  }

  listGoalWatches(): GoalWatch[] {
    return (
      this.ctx.prep(`SELECT * FROM goal_watches WHERE live=1 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
  }

  /** Who wrote each live watch, and when. → docs/spec/34-usage-metrics.md#who-decided */
  listWatchAuthorship(): { authored: string; createdAt: string }[] {
    const rows = this.ctx.prep(`SELECT authored, created_at FROM goal_watches WHERE live=1`).all() as {
      authored: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ authored: r.authored, createdAt: r.created_at }));
  }

  listProposedGoalWatches(): GoalWatch[] {
    return (
      this.ctx.prep(`SELECT * FROM goal_watches WHERE live=0 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
  }

  proposeGoalWatch(originRef: string, checks: readonly GoalWatchInput[], note: string): { proposed: string[] } {
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      const seqBase =
        (
          this.ctx.prep(`SELECT MAX(seq) AS top FROM goal_watches WHERE goal_ref=?`).get(originRef) as {
            top: number | null;
          }
        ).top ?? 0;
      for (const [index, check] of checks.entries()) {
        const declaration: GoalWatchInput = { ...check, seq: seqBase + index + 1 };
        const proposal: GoalWatchProposal = { at: now, note, declaration };
        const existing = this.ctx
          .prep(`SELECT check_id FROM goal_watches WHERE goal_ref=? AND check_id=?`)
          .get(originRef, check.id);
        if (existing) {
          this.ctx
            .prep(`UPDATE goal_watches SET proposal=?, updated_at=? WHERE goal_ref=? AND check_id=?`)
            .run(JSON.stringify(proposal), now, originRef, check.id);
          continue;
        }
        this.ctx
          .prep(
            `INSERT INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why, source,
                baseline_value, baseline_at, live, proposal, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source,
                NULL, NULL, 0, @proposal, 'plan',
                NULL, NULL, NULL, NULL, NULL, NULL, @now, @now)`,
          )
          .run({
            ...declaration,
            expectBaseline: declaration.expectBaseline ? 1 : 0,
            proposal: JSON.stringify(proposal),
            goalRef: originRef,
            now,
          });
      }
    })();
    return { proposed: checks.map((c) => c.id) };
  }

  ruleOnWatchProposal(originRef: string, checkId: string, accept: boolean): GoalWatch | null {
    const row = this.ctx.prep(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`).get(originRef, checkId) as
      GoalWatchRow | undefined;
    if (row === undefined || row.proposal === null) return null;
    const proposal = JSON.parse(row.proposal) as GoalWatchProposal;
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      if (!accept) {
        if (row.live === 0) {
          this.ctx.prep(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
          return;
        }
        this.ctx
          .prep(`UPDATE goal_watches SET proposal=NULL, updated_at=? WHERE goal_ref=? AND check_id=?`)
          .run(now, originRef, checkId);
        return;
      }
      this.ctx
        .prep(
          `UPDATE goal_watches
              SET kind=@kind, title=@title, query=@query, presence=@presence, tolerate=@tolerate,
                  expect_under=@expectUnder, expect_over=@expectOver, expect_baseline=@expectBaseline,
                  unit=@unit, why=@why, source=@source, live=1, proposal=NULL,
                  baseline_value=NULL, baseline_at=NULL,
                  dry_run_environment=NULL, dry_run_at=NULL, dry_run_verdict=NULL,
                  dry_run_presence=NULL, dry_run_rows=NULL, dry_run_detail=NULL, updated_at=@now
            WHERE goal_ref=@goalRef AND check_id=@checkId`,
        )
        .run({
          ...proposal.declaration,
          source: proposal.declaration.source ?? null,
          expectBaseline: proposal.declaration.expectBaseline ? 1 : 0,
          goalRef: originRef,
          checkId,
          now,
        });
      this.ctx.prep(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
    })();
    const after = this.ctx
      .prep(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
      .get(originRef, checkId) as GoalWatchRow | undefined;
    return after === undefined ? null : hydrate(after);
  }

  saveOperatorWatch(originRef: string, check: Omit<GoalWatchInput, 'seq'>): GoalWatch {
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      const row = this.ctx
        .prep(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
        .get(originRef, check.id) as GoalWatchRow | undefined;
      const asked =
        row !== undefined &&
        row.query === check.query &&
        row.presence === check.presence &&
        row.source === check.source;
      this.ctx
        .prep(
          `INSERT OR REPLACE INTO goal_watches
             (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
              expect_under, expect_over, expect_baseline, unit, why, source,
              baseline_value, baseline_at, live, proposal, authored,
              dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
              created_at, updated_at)
           VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
              @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source,
              @baselineValue, @baselineAt, 1, NULL, 'operator',
              @dryRunEnvironment, @dryRunAt, @dryRunVerdict, @dryRunPresence, @dryRunRows, @dryRunDetail,
              @createdAt, @now)`,
        )
        .run({
          ...check,
          expectBaseline: check.expectBaseline ? 1 : 0,
          seq: row?.seq ?? this.nextWatchSeq(originRef),
          ...keptAnswers(asked ? row : null),
          createdAt: row?.created_at ?? now,
          goalRef: originRef,
          now,
        });
      if (!asked) this.ctx.prep(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, check.id);
    })();
    const saved = this.ctx
      .prep(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
      .get(originRef, check.id) as GoalWatchRow;
    return hydrate(saved);
  }

  deleteGoalWatch(originRef: string, checkId: string): boolean {
    return this.ctx.db.transaction(() => {
      const gone = this.ctx
        .prep(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`)
        .run(originRef, checkId).changes;
      if (gone === 0) return false;
      this.ctx.prep(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
      return true;
    })();
  }

  /**
   * The checks a dry run puts to an environment: the live ones, and the assessor's set while it is
   * still proposed — the dry run is the one thing a proposal is allowed to do before the accept.
   * → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
   */
  listDryRunWatches(originRef: string): GoalWatch[] {
    return (
      this.ctx
        .prep(`SELECT * FROM goal_watches WHERE goal_ref=? AND (live=1 OR authored='assessor') ORDER BY seq`)
        .all(originRef) as GoalWatchRow[]
    ).map(hydrate);
  }

  /**
   * `watch_plan`'s write: the whole watch, proposed. Every row on the goal that is neither the
   * operator's own nor live is replaced — an earlier call's set, a sent-back set, a pending
   * `watch_declare` row — and the declared checks land `live=0`, `authored='assessor'`. The tool has
   * already refused a goal whose watch is live. → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
   */
  authorWatchPlan(
    originRef: string,
    checks: readonly (GoalWatchInput & { changedFromHint: string | null })[],
    input: { note: string; emptyReason: string | null },
  ): WatchPlanRecord {
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      this.ctx
        .prep(
          `DELETE FROM watch_readings WHERE goal_ref=? AND check_id IN
             (SELECT check_id FROM goal_watches WHERE goal_ref=? AND live=0 AND authored<>'operator')`,
        )
        .run(originRef, originRef);
      this.ctx.prep(`DELETE FROM goal_watches WHERE goal_ref=? AND live=0 AND authored<>'operator'`).run(originRef);
      for (const check of checks)
        this.ctx
          .prep(
            `INSERT INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why, source, changed_from_hint,
                baseline_value, baseline_at, live, proposal, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source, @changedFromHint,
                NULL, NULL, 0, NULL, 'assessor',
                NULL, NULL, NULL, NULL, NULL, NULL, @now, @now)`,
          )
          .run({ ...check, expectBaseline: check.expectBaseline ? 1 : 0, goalRef: originRef, now });
      this.ctx
        .prep(
          `INSERT INTO watch_plans (goal_ref, authored_at, note, empty_reason, accepted_at, sent_back_at,
                                    sent_back_words, updated_at)
           VALUES (@goalRef, @now, @note, @emptyReason, NULL, NULL, NULL, @now)
           ON CONFLICT(goal_ref) DO UPDATE SET authored_at=excluded.authored_at, note=excluded.note,
             empty_reason=excluded.empty_reason, accepted_at=NULL, updated_at=excluded.updated_at`,
        )
        .run({ goalRef: originRef, now, ...input });
    })();
    return this.getWatchPlanRecord(originRef) as WatchPlanRecord;
  }

  /**
   * The operator's accept: the proposed set goes live, together, and the record is stamped. Null where
   * nothing is authored and waiting. The dry run and baseline the proposal already took are kept —
   * they are readings of that same question. → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
   */
  acceptWatchPlan(originRef: string): WatchPlanRecord | null {
    const record = this.getWatchPlanRecord(originRef);
    if (record === null || record.authoredAt === null || record.acceptedAt !== null) return null;
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      this.ctx
        .prep(`UPDATE goal_watches SET live=1, updated_at=? WHERE goal_ref=? AND live=0 AND authored='assessor'`)
        .run(now, originRef);
      this.ctx.prep(`UPDATE watch_plans SET accepted_at=?, updated_at=? WHERE goal_ref=?`).run(now, now, originRef);
    })();
    return this.getWatchPlanRecord(originRef);
  }

  /**
   * The operator's send-back: the stamp comes off and their words are kept for the next author. The
   * proposed rows stay, as the account of what was refused, until the next `watch_plan` replaces them.
   * → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
   */
  sendBackWatchPlan(originRef: string, words: string): WatchPlanRecord | null {
    const record = this.getWatchPlanRecord(originRef);
    if (record === null || record.authoredAt === null || record.acceptedAt !== null) return null;
    const now = this.ctx.now();
    this.ctx
      .prep(`UPDATE watch_plans SET authored_at=NULL, sent_back_at=?, sent_back_words=?, updated_at=? WHERE goal_ref=?`)
      .run(now, words, now, originRef);
    return this.getWatchPlanRecord(originRef);
  }

  getWatchPlanRecord(originRef: string): WatchPlanRecord | null {
    const row = this.ctx.prep(`SELECT * FROM watch_plans WHERE goal_ref=?`).get(originRef) as WatchPlanRow | undefined;
    return row === undefined ? null : hydratePlan(row);
  }

  listWatchPlanRecords(): WatchPlanRecord[] {
    return (this.ctx.prep(`SELECT * FROM watch_plans ORDER BY goal_ref`).all() as WatchPlanRow[]).map(hydratePlan);
  }

  private nextWatchSeq(originRef: string): number {
    const { top } = this.ctx.prep(`SELECT MAX(seq) AS top FROM goal_watches WHERE goal_ref=?`).get(originRef) as {
      top: number | null;
    };
    return (top ?? 0) + 1;
  }

  openWatchWindow(input: { goalRef: string; environment: string; openedAt: string; settlesAt: string }): void {
    this.ctx
      .prep(
        `INSERT OR IGNORE INTO watch_windows
           (goal_ref, environment, opened_at, settles_at, settled_at, extended_at, exposed_at)
         VALUES (@goalRef, @environment, @openedAt, @settlesAt, NULL, NULL, NULL)`,
      )
      .run(input);
  }

  /** The rollout cleared the floor: the window's clock restarts from here. Stamped once. */
  markWatchWindowExposed(goalRef: string, environment: string, exposedAt: string, settlesAt: string): void {
    this.ctx
      .prep(
        `UPDATE watch_windows SET exposed_at=?, settles_at=?
          WHERE goal_ref=? AND environment=? AND exposed_at IS NULL AND settled_at IS NULL`,
      )
      .run(exposedAt, settlesAt, goalRef, environment);
  }

  settleWatchWindow(goalRef: string, environment: string): void {
    this.ctx
      .prep(`UPDATE watch_windows SET settled_at=? WHERE goal_ref=? AND environment=? AND settled_at IS NULL`)
      .run(this.ctx.now(), goalRef, environment);
  }

  extendWatchWindow(goalRef: string, environment: string, settlesAt: string): WatchWindow | null {
    const now = this.ctx.now();
    const changed = this.ctx
      .prep(`UPDATE watch_windows SET settles_at=?, settled_at=NULL, extended_at=? WHERE goal_ref=? AND environment=?`)
      .run(settlesAt, now, goalRef, environment).changes;
    if (changed === 0) return null;
    const row = this.ctx
      .prep(`SELECT * FROM watch_windows WHERE goal_ref=? AND environment=?`)
      .get(goalRef, environment) as WatchWindowRow;
    return hydrateWindow(row);
  }

  listWatchWindows(): WatchWindow[] {
    const rows = this.ctx
      .prep(`SELECT * FROM watch_windows ORDER BY opened_at ASC, environment ASC`)
      .all() as WatchWindowRow[];
    return rows.map(hydrateWindow);
  }

  recordWatchReading(input: {
    goalRef: string;
    environment: string;
    checkId: string;
    verdict: WatchCheckVerdict;
    rows: number | null;
    value: number | null;
    detail: string | null;
  }): void {
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO watch_readings
           (goal_ref, environment, check_id, read_at, verdict, rows_read, value, detail)
         VALUES (@goalRef, @environment, @checkId, @readAt, @verdict, @rows, @value, @detail)`,
      )
      .run({ ...input, readAt: this.ctx.now() });
  }

  listWatchReadings(): WatchReading[] {
    const rows = this.ctx
      .prep(`SELECT * FROM watch_readings ORDER BY read_at ASC, check_id ASC`)
      .all() as WatchReadingRow[];
    return rows.map((r) => ({
      goalRef: r.goal_ref,
      environment: r.environment,
      checkId: r.check_id,
      readAt: r.read_at,
      verdict: r.verdict as WatchCheckVerdict,
      rows: r.rows_read,
      value: r.value,
      detail: r.detail,
    }));
  }
}
