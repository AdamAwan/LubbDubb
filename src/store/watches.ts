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
 * Three tables. `goal_watches` — what each goal declared a running system would
 * have to show for its work to have done what it claimed, and what the dry run
 * read against it — plus the two the window is made of: `watch_windows`, one per
 * `(goal, environment)` an arrival opened, and `watch_readings`, what each check
 * answered each time the window was read.
 *
 * `goal_watches` is one row per `(goal_ref, check_id)`, written `OR REPLACE` on
 * the declaration: the merge key is the author's own slug, exactly as a part's is
 * and a validation check's is, so an amended plan lands on the row rather than
 * beside it.
 *
 * **A reading is not a `WorldEvent`, and this table is why it does not have to
 * be.** `deliveryHold` expires a standing delivery verdict on *any* world event
 * matching the goal's issue ref, so a reading written as one would un-park the
 * goal it just reported on and hand finished work back to the fleet to do again.
 * Own table, own wire list, merged at the feed's door — what arrivals already do.
 *
 * The tables were new *once*, which is exactly what does not keep them exempt:
 * measures, the pending amendment and an operator's extension have since added
 * columns to all three, and they are declared in {@link WATCH_COLUMNS} below.
 * `watch_windows.settled_at` null means *still watching*, so a column added to
 * **that** table needs its null read before anything else — one whose absence
 * means something needs a backfill gated on `ensureColumns`' report, or every
 * settled window reopens on the boot an operator takes the build.
 * → `docs/spec/29-post-deploy-watch.md#persistence`
 */

/**
 * The columns added to `goal_watches` and `watch_readings` since they were
 * created — measures, the baseline, and the pending amendment.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so without these
 * entries every one of them is invisible on every database from before this
 * build: a threshold, a baseline and a reading's `value` all read `undefined`,
 * which is a measure that can never fail on exactly the deployments with a
 * history. Nothing errors, and a measure nothing can fail looks like a measure
 * passing.
 *
 * **None of them needs a backfill, and each for a stated reason.**
 * `baseline_value` null means *never taken*, which the fold already reads as
 * `unknown` rather than as clean — a database full of nulls declares no measures
 * anyway, since the schema refused them until now. `expect_baseline` and `live`
 * carry SQL defaults that are the honest reading of a row written before either
 * existed: a signal declares no baseline, and every check the operator's own plan
 * approval already authorised is live.
 *
 * `watch_windows.extended_at` is the third table's first added column, and it is
 * the one the table's own warning is about: `settled_at` null means *still
 * watching*, so a column here whose null meant something would reopen every
 * settled window on the boot an operator takes the build. This one's null means
 * **never extended**, which is true of every row written before the column
 * existed, so there is nothing to backfill and nothing gated on
 * `ensureColumns`' report. That is a property of what the column says, not luck.
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
   * A document speaks for the **whole** watch, so a check it stopped declaring is
   * removed rather than left behind: at this stage a check row carries nothing but
   * its declaration and the dry run of that declaration, both of which the
   * amendment has replaced, and a row nothing declares is a query the harness
   * would go on asking on behalf of a plan that no longer asks it.
   *
   * The dry-run columns are **not** carried across a re-declaration, and that is
   * the point rather than an omission: the reading is a reading *of that query*,
   * and an amended query has never been run.
   *
   * **A dropped check takes its readings with it**, in the same transaction. Once
   * a window's readings hang off a check, deleting the row alone would orphan the
   * evidence behind a verdict — and the honest answer is not to keep the evidence
   * for a question nobody is asking any more, but to leave neither: a verdict with
   * nothing behind it is the shape that is unreadable six weeks later, and a
   * reading of a check no document declares is a number with no rule.
   *
   * **The sweep is over live rows only.** A row an agent proposed and nobody has
   * ruled on was never part of this document, so a replan neither adopts it nor
   * throws it away — it is the operator's to accept or decline, and a decision
   * taken off somebody without their seeing it is the failure this whole approval
   * exists to avoid. A pending amendment *to* a check the document still declares
   * is dropped with the re-declaration, because it was an amendment to text that
   * no longer stands.
   * → `docs/spec/29-post-deploy-watch.md#the-working-agent-at-conclude-time`
   */
  ingestGoalWatch(originRef: string, checks: readonly GoalWatchInput[]): void {
    const ids = checks.map((c) => c.id);
    this.ctx.db.transaction(() => {
      const keep = new Set(ids);
      for (const row of this.ctx.db
        .prepare(`SELECT check_id FROM goal_watches WHERE goal_ref=? AND live=1`)
        .all(originRef) as {
        check_id: string;
      }[]) {
        if (keep.has(row.check_id)) continue;
        this.ctx.db.prepare(`DELETE FROM goal_watches WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
        this.ctx.db.prepare(`DELETE FROM watch_readings WHERE goal_ref=? AND check_id=?`).run(originRef, row.check_id);
      }
      for (const check of checks) {
        this.ctx.db
          .prepare(
            `INSERT OR REPLACE INTO goal_watches
               (goal_ref, check_id, seq, kind, title, query, presence, tolerate,
                expect_under, expect_over, expect_baseline, unit, why,
                baseline_value, baseline_at, live, proposal,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why,
                NULL, NULL, 1, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL, @now, @now)`,
          )
          .run({ ...check, expectBaseline: check.expectBaseline ? 1 : 0, goalRef: originRef, now: this.ctx.now() });
      }
    })();
  }

  /**
   * What the dry run read, stored on the check it was a reading of — **and, for a
   * measure that answered a number, the baseline.**
   *
   * The baseline is not a second reading: it is this one, kept rather than
   * discarded, which is the whole of why it can be trusted as a before. A second
   * call, on a second schedule, would be free to ask a different question of a
   * system that had already changed.
   *
   * `value` null leaves the columns as they are rather than clearing them, because
   * the one thing that clears a baseline is a re-declaration — a baseline is a
   * reading of *that* query, and a dry run that failed has not replaced it.
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
   * Every **live** check, in document order within each goal, each carrying
   * whatever amendment is pending against it.
   *
   * Live only, and that is the guard rather than a filter: every reader of this —
   * the dry run, the window pass, the card — would otherwise put an agent's
   * unapproved query to the operator's own telemetry, which is the one thing the
   * approval exists to prevent. A row awaiting a ruling is reached through
   * {@link listProposedGoalWatches}, which nothing but the plan sheet reads.
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
   * An agent's declaration, filed against the operator rather than against the
   * environment.
   *
   * **Nothing here is live.** A slug the goal already carries takes the proposal
   * on its row and leaves the live check untouched; a slug it does not gets a row
   * of its own with `live=0`, whose declaration columns are the proposal's so that
   * accepting is the flag rather than a second write of the same text. Either way
   * no query is put to an environment, because the query runs inside the
   * operator's own command with the operator's own credential — and that approval
   * is the whole authorisation story.
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
                baseline_value, baseline_at, live, proposal,
                dry_run_environment, dry_run_at, dry_run_verdict, dry_run_presence, dry_run_rows, dry_run_detail,
                created_at, updated_at)
             VALUES (@goalRef, @id, @seq, @kind, @title, @query, @presence, @tolerate,
                @expectUnder, @expectOver, @expectBaseline, @unit, @why,
                NULL, NULL, 0, @proposal,
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
   * The operator's ruling on one pending declaration.
   *
   * Accepting writes the proposal over the live columns and **clears every reading
   * of the text it replaced** — the dry run, the baseline and the window's own
   * readings — for the reason a planner's amendment does: a reading is a reading
   * of *that* query, and leaving one standing under new text is a verdict about a
   * question nobody asked. The caller re-runs the dry run, which is what takes the
   * new baseline.
   *
   * Declining leaves a live check exactly as it was, and deletes a row that was
   * never anything but a proposal.
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
   * Open a window on an arrival.
   *
   * `OR IGNORE`, for {@link EnvironmentStore.recordGoalArrival}'s reason and one
   * sharper: a goal that grows another pull request and is confirmed again has not
   * arrived twice — and replacing would move `settles_at` forward, or worse clear
   * `settled_at`, which is **a settled watch re-opened by a later reading**. That
   * is a record of what happened after a deploy, not a monitor.
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
   * Fix a window's verdict: its readings stop and its rows stay on the goal page
   * as the permanent account of what production said about this work.
   *
   * The `settled_at IS NULL` guard is the whole of the one-way rule, in SQL rather
   * than in a caller: a second settle cannot move the stamp, so nothing about when
   * a window closed depends on which pass got to it.
   */
  settleWatchWindow(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE watch_windows SET settled_at=? WHERE goal_ref=? AND environment=? AND settled_at IS NULL`)
      .run(this.ctx.now(), goalRef, environment);
  }

  /**
   * Give a window more time, on the operator's own click.
   *
   * **It re-opens *this* window rather than opening a second one**, which is the
   * shape the table has: a row is keyed on `(goal_ref, environment)`, so a second
   * window would be a different key, and the goal's readings would be one series
   * split across two rows nothing joins. Re-opening keeps the account whole — the
   * readings taken before the window ran out are still the evidence behind what it
   * says next.
   *
   * That is deliberately the one thing that clears `settled_at`, and it does not
   * weaken {@link settleWatchWindow}'s guard: what that guard prevents is a
   * *later reading* moving a stamp the harness already wrote, and nothing here is
   * a reading. Between the two, a settled verdict is put back in play only by
   * somebody deciding it should be.
   *
   * Null back means no such window, which the route refuses rather than reporting
   * as done: a click that extended nothing must not answer `ok`.
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
   * Append what one check answered.
   *
   * Append-only and keyed on the read time, so a window keeps the series rather
   * than the last answer: the readings are the evidence behind the verdict, and a
   * row overwritten in place would leave the verdict standing with nothing behind
   * it. Bounded by `for` over `watchIntervalMs` — 96 rows per check per
   * environment on the defaults — rather than by a retention rule.
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
    dryRunEnvironment: row.dry_run_environment,
    dryRunAt: row.dry_run_at,
    dryRunVerdict: row.dry_run_verdict as WatchReadingVerdict | null,
    dryRunPresence: row.dry_run_presence as WatchReadingVerdict | null,
    dryRunRows: row.dry_run_rows,
    dryRunDetail: row.dry_run_detail,
  };
}
