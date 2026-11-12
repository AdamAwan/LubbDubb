import type {
  GoalWatch,
  GoalWatchInput,
  WatchAsk,
  WatchAskKind,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchPlanRecord,
  WatchSourceRunner,
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
  type WatchAskRow,
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
  watch_readings: { value: 'REAL', read_by: 'TEXT' },
  watch_windows: { extended_at: 'TEXT', exposed_at: 'TEXT' },
  watch_plans: {},
  watch_asks: {},
};

/**
 * Every boot: drop what `watch_declare` left proposed (`live=0`, `authored='plan'`) and the readings taken
 * against it. Nothing reads or rules on such a row since the tool was retired, and the predicate is
 * idempotent, so a further pass deletes nothing. → docs/spec/14-persistence.md#retired-watch-proposals
 */
export function deleteRetiredWatchProposals(db: Database.Database): void {
  db.prepare(
    `DELETE FROM watch_readings WHERE EXISTS (SELECT 1 FROM goal_watches w WHERE w.goal_ref = watch_readings.goal_ref
       AND w.check_id = watch_readings.check_id AND w.live = 0 AND w.authored = 'plan')`,
  ).run();
  db.prepare(`DELETE FROM goal_watches WHERE live = 0 AND authored = 'plan'`).run();
}

export class WatchStore {
  constructor(private readonly ctx: StoreContext) {}

  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    this.ctx.db.transaction(() => {
      const keep = new Set(checks.map((c) => c.id));
      const mine = new Set<string>();
      for (const row of this.ctx
        .prep(`SELECT check_id, authored FROM goal_watches WHERE goal_ref=?`)
        .all(originRef) as {
        check_id: string;
        authored: string;
      }[]) {
        if (row.authored === 'operator' || row.authored === 'assessor') {
          mine.add(row.check_id);
          continue;
        }
        if (keep.has(row.check_id)) continue;
        this.ctx.prep(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
        this.dropCheckState(originRef, row.check_id);
      }
      for (const check of checks) {
        if (mine.has(check.id)) continue;
        this.ctx
          .prep(
            `INSERT OR REPLACE INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why, source,
                baseline_value, baseline_at, live, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source,
                NULL, NULL, 1, 'plan',
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

  /** One goal's live checks. */
  listLiveGoalWatches(originRef: string): GoalWatch[] {
    return (
      this.ctx
        .prep(`SELECT * FROM goal_watches WHERE goal_ref=? AND live=1 ORDER BY seq`)
        .all(originRef) as GoalWatchRow[]
    ).map(hydrate);
  }

  /** The goals carrying at least one live check, whoever wrote it. */
  listWatchedGoalRefs(): string[] {
    return (
      this.ctx.prep(`SELECT DISTINCT goal_ref FROM goal_watches WHERE live=1 ORDER BY goal_ref`).all() as {
        goal_ref: string;
      }[]
    ).map((r) => r.goal_ref);
  }

  /** The assessor's sets still awaiting the operator's accept. */
  listProposedGoalWatches(): GoalWatch[] {
    return (
      this.ctx.prep(`SELECT * FROM goal_watches WHERE live=0 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
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
              baseline_value, baseline_at, live, authored,
              dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
              created_at, updated_at)
           VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
              @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source,
              @baselineValue, @baselineAt, 1, 'operator',
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
      if (!asked) this.dropCheckState(originRef, check.id);
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
      this.dropCheckState(originRef, checkId);
      return true;
    })();
  }

  /**
   * The checks a dry run puts to an environment: every one on the goal, the assessor's set while it is
   * still proposed included — the dry run is the one thing a proposal is allowed to do before the accept.
   * → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set
   */
  listDryRunWatches(originRef: string): GoalWatch[] {
    return (
      this.ctx.prep(`SELECT * FROM goal_watches WHERE goal_ref=? ORDER BY seq`).all(originRef) as GoalWatchRow[]
    ).map(hydrate);
  }

  /**
   * `watch_plan`'s write: the whole watch, proposed. Every row on the goal that is not live is replaced —
   * an earlier call's set, a sent-back set — and the declared checks land `live=0`, `authored='assessor'`. → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
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
             (SELECT check_id FROM goal_watches WHERE goal_ref=? AND live=0)`,
        )
        .run(originRef, originRef);
      this.ctx.prep(`DELETE FROM goal_watches WHERE goal_ref=? AND live=0`).run(originRef);
      for (const check of checks)
        this.ctx
          .prep(
            `INSERT INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why, source, changed_from_hint,
                baseline_value, baseline_at, live, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why, @source, @changedFromHint,
                NULL, NULL, 0, 'assessor',
                NULL, NULL, NULL, NULL, NULL, NULL, @now, @now)`,
          )
          .run({ ...check, expectBaseline: check.expectBaseline ? 1 : 0, goalRef: originRef, now });
      this.writePlan({
        goalRef: originRef,
        authoredAt: now,
        ...input,
        acceptedAt: null,
        sentBackWords: this.getWatchPlanRecord(originRef)?.sentBackWords ?? null,
      });
    })();
    return this.getWatchPlanRecord(originRef) as WatchPlanRecord;
  }

  /**
   * The obligation, written when the assessor's `delivered` verdict is recorded on a goal the watch is asked
   * of. A goal that already has a record keeps it: a re-delivery re-asks only where something un-authored the
   * watch on purpose. → docs/spec/29-post-deploy-watch.md#the-assessor-on-delivered-writes-the-checks
   */
  oweWatchPlan(originRef: string): void {
    if (this.getWatchPlanRecord(originRef) !== null) return;
    this.writePlan({
      goalRef: originRef,
      authoredAt: null,
      note: null,
      emptyReason: null,
      acceptedAt: null,
      sentBackWords: null,
    });
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
      this.ctx.prep(`UPDATE goal_watches SET live=1, updated_at=? WHERE goal_ref=? AND live=0`).run(now, originRef);
      this.writePlan({ ...record, acceptedAt: now });
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
    this.writePlan({ ...record, authoredAt: null, sentBackWords: words });
    return this.getWatchPlanRecord(originRef);
  }

  getWatchPlanRecord(originRef: string): WatchPlanRecord | null {
    const row = this.ctx.prep(`SELECT * FROM watch_plans WHERE goal_ref=?`).get(originRef) as WatchPlanRow | undefined;
    return row === undefined ? null : hydratePlan(row);
  }

  listWatchPlanRecords(): WatchPlanRecord[] {
    return (this.ctx.prep(`SELECT * FROM watch_plans ORDER BY goal_ref`).all() as WatchPlanRow[]).map(hydratePlan);
  }

  /** The one write `watch_plans` has: every column, from a whole record. */
  private writePlan(record: WatchPlanRecord): void {
    this.ctx
      .prep(
        `INSERT INTO watch_plans (goal_ref, authored_at, note, empty_reason, accepted_at, sent_back_words, updated_at)
         VALUES (@goalRef, @authoredAt, @note, @emptyReason, @acceptedAt, @sentBackWords, @now)
         ON CONFLICT(goal_ref) DO UPDATE SET authored_at=excluded.authored_at, note=excluded.note,
           empty_reason=excluded.empty_reason, accepted_at=excluded.accepted_at,
           sent_back_words=excluded.sent_back_words, updated_at=excluded.updated_at`,
      )
      .run({ ...record, now: this.ctx.now() });
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
    readBy?: WatchSourceRunner;
  }): void {
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO watch_readings
           (goal_ref, environment, check_id, read_at, verdict, rows_read, value, detail, read_by)
         VALUES (@goalRef, @environment, @checkId, @readAt, @verdict, @rows, @value, @detail, @readBy)`,
      )
      .run({ ...input, readBy: input.readBy ?? 'harness', readAt: this.ctx.now() });
  }

  /** What a `watch_reading` bench row asks. Null where the row is not one, or its ask was never recorded. */
  getWatchAsk(taskId: string): WatchAsk | null {
    const row = this.ctx.prep(`SELECT * FROM watch_asks WHERE task_id=?`).get(taskId) as WatchAskRow | undefined;
    return row === undefined ? null : hydrateAsk(row);
  }

  /** Every ask, or one goal's. */
  listWatchAsks(goalRef?: string): WatchAsk[] {
    const rows = (
      goalRef === undefined
        ? this.ctx.prep(`SELECT * FROM watch_asks ORDER BY goal_ref, check_id`).all()
        : this.ctx.prep(`SELECT * FROM watch_asks WHERE goal_ref=? ORDER BY check_id`).all(goalRef)
    ) as WatchAskRow[];
    return rows.map(hydrateAsk);
  }

  /** One per check per environment per ask: a second write for the same key moves its period, never adds a row. */
  recordWatchAsk(ask: WatchAsk): void {
    this.ctx
      .prep(
        `INSERT INTO watch_asks (task_id, goal_ref, check_id, environment, ask, since, until)
         VALUES (@taskId, @goalRef, @checkId, @environment, @ask, @since, @until)
         ON CONFLICT(goal_ref, check_id, environment, ask) DO UPDATE SET
           task_id=excluded.task_id, since=excluded.since, until=excluded.until`,
      )
      .run(ask);
  }

  /** One window's asks of one kind, whatever became of their rows: the question they asked is gone. */
  dropWindowAsks(goalRef: string, environment: string, ask: WatchAskKind): void {
    this.ctx.prep(`DELETE FROM watch_asks WHERE goal_ref=? AND environment=? AND ask=?`).run(goalRef, environment, ask);
  }

  /** A check's readings and asks, which describe the query it no longer carries. */
  private dropCheckState(originRef: string, checkId: string): void {
    this.ctx.prep(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
    this.ctx.prep(`DELETE FROM watch_asks WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
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
      readBy: r.read_by === 'operator' ? 'operator' : 'harness',
    }));
  }
}

function hydrateAsk(row: WatchAskRow): WatchAsk {
  return {
    taskId: row.task_id,
    goalRef: row.goal_ref,
    checkId: row.check_id,
    environment: row.environment,
    ask: row.ask === 'closing' ? 'closing' : 'baseline',
    since: row.since,
    until: row.until,
  };
}
