import type {
  GoalWatch,
  GoalWatchInput,
  GoalWatchKind,
  GoalWatchProposal,
  WatchCheckVerdict,
  WatchReading,
  WatchReadingVerdict,
  WatchWindow,
} from '../types.js';
import type { StoreContext } from './context.js';
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
  },
  watch_readings: { value: 'REAL' },
  watch_windows: { extended_at: 'TEXT' },
};

export class WatchStore {
  constructor(private readonly ctx: StoreContext) {}

  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    this.ctx.db.transaction(() => {
      const keep = new Set(checks.map((c) => c.id));
      const mine = new Set<string>();
      for (const row of this.ctx.db
        .prepare(`SELECT check_id, authored FROM goal_watches WHERE goal_ref=? AND live=1`)
        .all(originRef) as {
        check_id: string;
        authored: string;
      }[]) {
        if (row.authored === 'operator') {
          mine.add(row.check_id);
          continue;
        }
        if (keep.has(row.check_id)) continue;
        this.ctx.db.prepare(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
        this.ctx.db.prepare(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
      }
      for (const check of checks) {
        if (mine.has(check.id)) continue;
        this.ctx.db
          .prepare(
            `INSERT OR REPLACE INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why,
                baseline_value, baseline_at, live, proposal, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why,
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
    this.ctx.db
      .prepare(
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
      this.ctx.db.prepare(`SELECT * FROM goal_watches WHERE live=1 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
  }

  listProposedGoalWatches(): GoalWatch[] {
    return (
      this.ctx.db.prepare(`SELECT * FROM goal_watches WHERE live=0 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
  }

  proposeGoalWatch(originRef: string, checks: readonly GoalWatchInput[], note: string): { proposed: string[] } {
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      const seqBase =
        (
          this.ctx.db.prepare(`SELECT MAX(seq) AS top FROM goal_watches WHERE goal_ref=?`).get(originRef) as {
            top: number | null;
          }
        ).top ?? 0;
      for (const [index, check] of checks.entries()) {
        const declaration: GoalWatchInput = { ...check, seq: seqBase + index + 1 };
        const proposal: GoalWatchProposal = { at: now, note, declaration };
        const existing = this.ctx.db
          .prepare(`SELECT check_id FROM goal_watches WHERE goal_ref=? AND check_id=?`)
          .get(originRef, check.id);
        if (existing) {
          this.ctx.db
            .prepare(`UPDATE goal_watches SET proposal=?, updated_at=? WHERE goal_ref=? AND check_id=?`)
            .run(JSON.stringify(proposal), now, originRef, check.id);
          continue;
        }
        this.ctx.db
          .prepare(
            `INSERT INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why,
                baseline_value, baseline_at, live, proposal, authored,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why,
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
    const row = this.ctx.db
      .prepare(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
      .get(originRef, checkId) as GoalWatchRow | undefined;
    if (row === undefined || row.proposal === null) return null;
    const proposal = JSON.parse(row.proposal) as GoalWatchProposal;
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      if (!accept) {
        if (row.live === 0) {
          this.ctx.db.prepare(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
          return;
        }
        this.ctx.db
          .prepare(`UPDATE goal_watches SET proposal=NULL, updated_at=? WHERE goal_ref=? AND check_id=?`)
          .run(now, originRef, checkId);
        return;
      }
      this.ctx.db
        .prepare(
          `UPDATE goal_watches
              SET kind=@kind, title=@title, query=@query, presence=@presence, tolerate=@tolerate,
                  expect_under=@expectUnder, expect_over=@expectOver, expect_baseline=@expectBaseline,
                  unit=@unit, why=@why, live=1, proposal=NULL,
                  baseline_value=NULL, baseline_at=NULL,
                  dry_run_environment=NULL, dry_run_at=NULL, dry_run_verdict=NULL,
                  dry_run_presence=NULL, dry_run_rows=NULL, dry_run_detail=NULL, updated_at=@now
            WHERE goal_ref=@goalRef AND check_id=@checkId`,
        )
        .run({
          ...proposal.declaration,
          expectBaseline: proposal.declaration.expectBaseline ? 1 : 0,
          goalRef: originRef,
          checkId,
          now,
        });
      this.ctx.db.prepare(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
    })();
    const after = this.ctx.db
      .prepare(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
      .get(originRef, checkId) as GoalWatchRow | undefined;
    return after === undefined ? null : hydrate(after);
  }

  saveOperatorWatch(originRef: string, check: Omit<GoalWatchInput, 'seq'>): GoalWatch {
    const now = this.ctx.now();
    this.ctx.db.transaction(() => {
      const row = this.ctx.db
        .prepare(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
        .get(originRef, check.id) as GoalWatchRow | undefined;
      const asked = row !== undefined && row.query === check.query && row.presence === check.presence;
      this.ctx.db
        .prepare(
          `INSERT OR REPLACE INTO goal_watches
             (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
              expect_under, expect_over, expect_baseline, unit, why,
              baseline_value, baseline_at, live, proposal, authored,
              dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
              created_at, updated_at)
           VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
              @expectUnder, @expectOver, @expectBaseline, @unit, @why,
              @baselineValue, @baselineAt, 1, NULL, 'operator',
              @dryRunEnvironment, @dryRunAt, @dryRunVerdict, @dryRunPresence, @dryRunRows, @dryRunDetail,
              @createdAt, @now)`,
        )
        .run({
          ...check,
          expectBaseline: check.expectBaseline ? 1 : 0,
          seq: row?.seq ?? this.nextWatchSeq(originRef),
          baselineValue: asked ? row.baseline_value : null,
          baselineAt: asked ? row.baseline_at : null,
          dryRunEnvironment: asked ? row.dry_run_environment : null,
          dryRunAt: asked ? row.dry_run_at : null,
          dryRunVerdict: asked ? row.dry_run_verdict : null,
          dryRunPresence: asked ? row.dry_run_presence : null,
          dryRunRows: asked ? row.dry_run_rows : null,
          dryRunDetail: asked ? row.dry_run_detail : null,
          createdAt: row?.created_at ?? now,
          goalRef: originRef,
          now,
        });
      if (!asked)
        this.ctx.db.prepare(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, check.id);
    })();
    const saved = this.ctx.db
      .prepare(`SELECT * FROM goal_watches WHERE goal_ref=? AND check_id=?`)
      .get(originRef, check.id) as GoalWatchRow;
    return hydrate(saved);
  }

  deleteGoalWatch(originRef: string, checkId: string): boolean {
    return this.ctx.db.transaction(() => {
      const gone = this.ctx.db
        .prepare(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`)
        .run(originRef, checkId).changes;
      if (gone === 0) return false;
      this.ctx.db.prepare(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, checkId);
      return true;
    })();
  }

  private nextWatchSeq(originRef: string): number {
    const { top } = this.ctx.db.prepare(`SELECT MAX(seq) AS top FROM goal_watches WHERE goal_ref=?`).get(originRef) as {
      top: number | null;
    };
    return (top ?? 0) + 1;
  }

  openWatchWindow(input: { goalRef: string; environment: string; openedAt: string; settlesAt: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO watch_windows (goal_ref, environment, opened_at, settles_at, settled_at, extended_at)
         VALUES (@goalRef, @environment, @openedAt, @settlesAt, NULL, NULL)`,
      )
      .run(input);
  }

  settleWatchWindow(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE watch_windows SET settled_at=? WHERE goal_ref=? AND environment=? AND settled_at IS NULL`)
      .run(this.ctx.now(), goalRef, environment);
  }

  extendWatchWindow(goalRef: string, environment: string, settlesAt: string): WatchWindow | null {
    const now = this.ctx.now();
    const changed = this.ctx.db
      .prepare(
        `UPDATE watch_windows SET settles_at=?, settled_at=NULL, extended_at=? WHERE goal_ref=? AND environment=?`,
      )
      .run(settlesAt, now, goalRef, environment).changes;
    if (changed === 0) return null;
    const row = this.ctx.db
      .prepare(`SELECT * FROM watch_windows WHERE goal_ref=? AND environment=?`)
      .get(goalRef, environment) as WatchWindowRow;
    return hydrateWindow(row);
  }

  listWatchWindows(): WatchWindow[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM watch_windows ORDER BY opened_at ASC, environment ASC`)
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
    this.ctx.db
      .prepare(
        `INSERT OR REPLACE INTO watch_readings
           (goal_ref, environment, check_id, read_at, verdict, rows_read, value, detail)
         VALUES (@goalRef, @environment, @checkId, @readAt, @verdict, @rows, @value, @detail)`,
      )
      .run({ ...input, readAt: this.ctx.now() });
  }

  listWatchReadings(): WatchReading[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM watch_readings ORDER BY read_at ASC, check_id ASC`)
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

interface WatchWindowRow {
  goal_ref: string;
  environment: string;
  opened_at: string;
  settles_at: string;
  settled_at: string | null;
  extended_at: string | null;
}

function hydrateWindow(row: WatchWindowRow): WatchWindow {
  return {
    goalRef: row.goal_ref,
    environment: row.environment,
    openedAt: row.opened_at,
    settlesAt: row.settles_at,
    settledAt: row.settled_at,
    extendedAt: row.extended_at,
  };
}

interface WatchReadingRow {
  goal_ref: string;
  environment: string;
  check_id: string;
  read_at: string;
  verdict: string;
  rows_read: number | null;
  value: number | null;
  detail: string | null;
}

interface GoalWatchRow {
  goal_ref: string;
  created_at: string;
  check_id: string;
  seq: number;
  kind: string;
  title: string;
  query: string;
  presence: string | null;
  tolerate: number;
  expect_under: number | null;
  expect_over: number | null;
  expect_baseline: number;
  unit: string | null;
  baseline_value: number | null;
  baseline_at: string | null;
  live: number;
  proposal: string | null;
  authored: string;
  why: string | null;
  dry_run_environment: string | null;
  dry_run_at: string | null;
  dry_run_verdict: string | null;
  dry_run_presence: string | null;
  dry_run_rows: number | null;
  dry_run_detail: string | null;
}

function hydrate(row: GoalWatchRow): GoalWatch {
  return {
    originRef: row.goal_ref,
    id: row.check_id,
    seq: row.seq,
    kind: row.kind as GoalWatchKind,
    title: row.title,
    query: row.query,
    presence: row.presence,
    tolerate: row.tolerate,
    expectUnder: row.expect_under,
    expectOver: row.expect_over,
    expectBaseline: row.expect_baseline === 1,
    unit: row.unit,
    why: row.why,
    baselineValue: row.baseline_value,
    baselineAt: row.baseline_at,
    live: row.live === 1,
    proposal: row.proposal === null ? null : (JSON.parse(row.proposal) as GoalWatchProposal),
    authored: row.authored === 'operator' ? 'operator' : 'plan',
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict as WatchReadingVerdict | null,
    dryRunPresence: row.dry_run_presence as WatchReadingVerdict | null,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
  };
}
