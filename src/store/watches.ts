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

/**
 * Three tables. `goal_watches` — what each goal declared a running system would have to show,
 * and what the dry run read against it — plus `watch_windows`, one per `(goal, environment)`
 * an arrival opened, and `watch_readings`, what each check answered each time.
 *
 * `goal_watches` is one row per `(goal_ref, check_id)`, `OR REPLACE` on the declaration, so
 * an amended plan lands on the row rather than beside it.
 *
 * **A reading is never written as a `WorldEvent`**: `deliveryHold` expires a standing
 * delivery verdict on any world event matching the goal's issue ref, so one would un-park
 * the goal it just reported on. Own table, own wire list, merged at the feed's door.
 *
 * `watch_windows.settled_at` null means *still watching*, so a new column on that table
 * whose null means something needs a backfill gated on `ensureColumns`' report, or every
 * settled window reopens on the boot an operator takes the build.
 * → `docs/spec/29-post-deploy-watch.md#persistence`
 */

/**
 * The columns added to these tables since they were created — measures, the baseline, the
 * pending amendment, the extension. Without these entries each reads `undefined` on every
 * older database, and a measure that can never fail looks like a measure passing.
 *
 * None needs a backfill, each for a stated reason: `baseline_value` null already means
 * *never taken*; `expect_baseline` and `live` carry SQL defaults that are the honest reading
 * of an older row; `authored` defaults to `'plan'`, which is what every pre-edit row was (a
 * database reading `operator` throughout is a fleet no replan can amend); and
 * `watch_windows.extended_at` null means *never extended*, which is why this one column on
 * the settled-window table owes nothing despite that table's warning.
 * → `docs/spec/14-persistence.md#when-a-null-means-something`
 */
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

/** The three tables' writer and reader. One module per group of related tables, per the store's composition rule. */
export class WatchStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Fold a document's `watch` block onto a goal's rows.
   *
   * A document speaks for the **whole** watch, so a check it stopped declaring is removed,
   * and a dropped check takes its readings with it in the same transaction — a reading of a
   * check nothing declares is a number with no rule. Dry-run columns are not carried across
   * a re-declaration: a reading is a reading of *that* query.
   *
   * Two exclusions. The sweep is over **live rows only**, so a proposal nobody has ruled on
   * is neither adopted nor thrown away. And an **operator's own check is neither swept nor
   * overwritten**, because it was never in this document.
   * → `docs/spec/29-post-deploy-watch.md#the-operator-at-any-point`
   * → `docs/spec/29-post-deploy-watch.md#the-working-agent-at-conclude-time`
   */
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
        // Neither swept nor, below, overwritten: this row is not this document's.
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

  /**
   * What the dry run read, stored on the check it was a reading of — and, for a measure that
   * answered a number, the baseline. The baseline is this reading kept, never a second one.
   * `value` null leaves the columns alone: only a re-declaration clears a baseline.
   */
  recordWatchDryRun(
    originRef: string,
    checkId: string,
    reading: {
      environment: string;
      verdict: WatchReadingVerdict;
      presence: WatchReadingVerdict | null;
      rows: number | null;
      detail: string | null;
      /** A measure's number, or null for a signal and for an observation that did not answer. */
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

  /**
   * Every **live** check, in document order within each goal, each carrying whatever
   * amendment is pending against it. Live-only is the guard, not a filter: otherwise every
   * reader would put an agent's unapproved query to the operator's own telemetry. Rows
   * awaiting a ruling come through {@link listProposedGoalWatches}.
   */
  listGoalWatches(): GoalWatch[] {
    return (
      this.ctx.db.prepare(`SELECT * FROM goal_watches WHERE live=1 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
  }

  /** The checks an agent declared that nobody has ruled on yet — drawn on the plan sheet, asked of nothing. */
  listProposedGoalWatches(): GoalWatch[] {
    return (
      this.ctx.db.prepare(`SELECT * FROM goal_watches WHERE live=0 ORDER BY goal_ref, seq`).all() as GoalWatchRow[]
    ).map(hydrate);
  }

  /**
   * An agent's declaration, filed against the operator rather than against the environment.
   *
   * **Nothing here is live.** A slug the goal already carries takes the proposal on its row
   * and leaves the live check untouched; a new slug gets a `live=0` row whose declaration
   * columns are the proposal's, so accepting is the flag rather than a second write. No
   * query reaches an environment until the operator approves it.
   * → `docs/spec/29-post-deploy-watch.md#the-working-agent-at-conclude-time`
   */
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

  /**
   * The operator's ruling on one pending declaration. Accepting writes the proposal over the
   * live columns and **clears every reading of the text it replaced** — dry run, baseline and
   * window readings — because a reading standing under new text is a verdict about a question
   * nobody asked; the caller re-runs the dry run. Declining leaves a live check exactly as it
   * was and deletes a row that was only ever a proposal.
   */
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

  /**
   * The operator's own declaration, written from the goal page. Upsert on the slug, the same
   * merge key everything else here folds on.
   *
   * **Live immediately**: `live=0` holds back a query *an agent* wrote until the operator has
   * read it, and this one they typed. The caller runs the dry run straight after.
   *
   * **Readings are cleared only where the question changed** — an edited query or presence.
   * A re-worded title or changed threshold is the same question, and dropping its baseline
   * would cost a measure a before it cannot retake. Any pending proposal goes with the write.
   */
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
          // The store's, never the caller's: `seq` is display order, so an edit keeps its
          // position and a new check goes after the ones already placed.
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

  /**
   * Drop a check and the readings taken against it, whoever wrote it — both in one
   * transaction, since a reading of a check nothing declares is a number with no rule. False
   * back means there was no such row, which the route refuses rather than answering `ok`.
   */
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

  /** One past the goal's furthest position, live rows and proposals alike — display order only. */
  private nextWatchSeq(originRef: string): number {
    const { top } = this.ctx.db.prepare(`SELECT MAX(seq) AS top FROM goal_watches WHERE goal_ref=?`).get(originRef) as {
      top: number | null;
    };
    return (top ?? 0) + 1;
  }

  /**
   * Open a window on an arrival. `OR IGNORE`: a goal confirmed again has not arrived twice,
   * and replacing would move `settles_at` forward or clear `settled_at` — a settled watch
   * re-opened by a later reading.
   */
  openWatchWindow(input: { goalRef: string; environment: string; openedAt: string; settlesAt: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO watch_windows (goal_ref, environment, opened_at, settles_at, settled_at, extended_at)
         VALUES (@goalRef, @environment, @openedAt, @settlesAt, NULL, NULL)`,
      )
      .run(input);
  }

  /**
   * Fix a window's verdict: its readings stop and its rows stay as the permanent account of
   * what production said. The `settled_at IS NULL` guard is the one-way rule, in SQL rather
   * than in a caller, so a second settle cannot move the stamp.
   */
  settleWatchWindow(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE watch_windows SET settled_at=? WHERE goal_ref=? AND environment=? AND settled_at IS NULL`)
      .run(this.ctx.now(), goalRef, environment);
  }

  /**
   * Give a window more time, on the operator's own click. It re-opens *this* window rather
   * than opening a second one, so the goal's readings stay one series.
   *
   * This is deliberately the only thing that clears `settled_at`; {@link settleWatchWindow}'s
   * guard is about a later *reading* moving a stamp, and nothing here is a reading. Null back
   * means no such window, which the route refuses rather than answering `ok`.
   */
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

  /** Every window, oldest first — the order the desk drains its per-pulse cap in. */
  listWatchWindows(): WatchWindow[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM watch_windows ORDER BY opened_at ASC, environment ASC`)
      .all() as WatchWindowRow[];
    return rows.map(hydrateWindow);
  }

  /**
   * Append what one check answered. Append-only and keyed on the read time, so a window
   * keeps the series that is the evidence behind its verdict. Bounded by the window's own
   * length over `watchIntervalMs`, not by a retention rule.
   */
  recordWatchReading(input: {
    goalRef: string;
    environment: string;
    checkId: string;
    verdict: WatchCheckVerdict;
    rows: number | null;
    /** A measure's number, or null for a signal and for anything that did not answer. */
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

  /** Every reading, oldest first. The newest per `(window, check)` is what the card draws. */
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

/** `watch_windows`, as `better-sqlite3` hands it back. */
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

/** `watch_readings`, the same. `rows_read` because `rows` is not a name SQLite likes. */
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

/** The table's own shape, as `better-sqlite3` hands it back. */
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
