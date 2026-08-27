import type {
  EnvironmentGateRelease,
  EnvironmentReachStatus,
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
} from '../types.js';
import type Database from 'better-sqlite3';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

/**
 * Four tables, one question: `goal_landings` — the commit each of a goal's pull
 * requests landed as — and `environment_reach`, what a probe said about each of
 * those commits in each environment.
 *
 * Together rather than apart because neither is readable alone: a landing with no
 * readings says nothing about where the work is, and a reading is keyed on a SHA
 * that only the landing attributes to a goal.
 *
 * **Both are stored because nothing else can answer them.** A squash merge leaves
 * no ancestry link, so the SHA is a provider fact with a `closedPrWindowMs`-long
 * shelf life and has to be caught while it is on offer; and a probe is a process
 * spawn, so re-asking it every pulse for every landing would put the cost of the
 * feature on the heartbeat.
 *
 * `goal_arrivals` and `environment_gate_releases` sit beside them because they are
 * the same subject read as *events* rather than as status: when a goal's work
 * first arrived somewhere, and the operator's answer for a goal that is never
 * going to.
 *
 * The tables were new once, which is exactly what stops keeping them exempt:
 * `goal_arrivals.watched_at` is the column the post-deploy watch added to an
 * existing table, and it is declared in {@link ENVIRONMENT_COLUMNS} below.
 * → `docs/spec/24-environments.md`
 */

/**
 * `goal_arrivals.watched_at` — when the watch pass considered an arrival, whether
 * or not it opened a window for it.
 *
 * The one column this module has added since its tables were created, and it needs
 * this entry for the reason every such column does: `CREATE TABLE IF NOT EXISTS`
 * never alters an existing table, so without it the column is invisible on every
 * database from before the watch shipped — and the freshness guard would read
 * `undefined` for every arrival on exactly the deployments that have a history to
 * storm.
 *
 * **It needs no backfill, and that is a property of the guard rather than an
 * oversight.** Null here means *not considered yet*, and an arrival considered for
 * the first time only opens a window if its confirming reading is within two probe
 * intervals of now — so a database full of nulls is walked once, stamped, and
 * opens nothing for work that shipped in March.
 * → `docs/spec/14-persistence.md#migrations`
 */
export const ENVIRONMENT_COLUMNS: ColumnMigrations = {
  goal_arrivals: { watched_at: 'TEXT' },
};

/**
 * Undo the landings and arrivals a part-ref goal was filed under (#472).
 *
 * `goalOfPr` stopped its walk on any ref starting with `issue:`, and since parts
 * arrived a part is one — `issue:35916:part:orc-bucket-config` — so every planned
 * goal's merges were attributed to whichever part opened the pull request. The
 * walk is fixed; these are the rows it already wrote, and neither table can be
 * left as it is: nothing ever asks about a part ref, so the goal reads as having
 * been nowhere and its gate never opens.
 *
 * **The two rows are repaired in opposite directions, because they claim
 * different things.**
 *
 * A landing is a fact about *one pull request* — the commit it merged as — and
 * the goal ref is only the label it is filed under, so truncating the `:part:…`
 * suffix restores the label without touching the fact. `pr_number` is the primary
 * key, so the rewrite cannot collide: two parts of one goal becoming two rows
 * under `issue:35916` is exactly what that goal's two landings are.
 *
 * An arrival is a claim about the goal's *whole* work, and a part-ref row makes it
 * about one part. Rewriting the ref would promote "one part of this is in testUk"
 * into "this goal has arrived" — an assertion nobody made, on a row that
 * `openedGoals` reads to release a `validate` or `close_out` hold. So they
 * are discarded, and the desk re-derives the real ones from the repaired landings:
 * an arrival is only recorded once *every* landing of the goal is confirmed.
 *
 * Re-deriving cannot re-comment on old tickets. `announceableArrivals` announces
 * only an arrival whose confirming reading is within two probe intervals of now,
 * and the readings behind these rows are already recorded — a goal confirmed last
 * week comes back stamped and silent, exactly as it would on a fresh database
 * that had been probing all along.
 *
 * Unconditional and idempotent, in `absorbSinglePlanStatus`' sense rather than
 * `openPetsFromBeforeEggs`': no column changed, so there is nothing to gate on,
 * and the fixed walk can never write a part ref again — a second boot finds
 * nothing to do, forever.
 */
export function repairPartRefGoals(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE goal_landings SET goal_ref = substr(goal_ref, 1, instr(goal_ref, ':part:') - 1)
       WHERE goal_ref LIKE 'issue:%:part:%'`,
    ).run();
    db.prepare(`DELETE FROM goal_arrivals WHERE goal_ref LIKE 'issue:%:part:%'`).run();
  })();
}

/**
 * Discard goal arrivals written before the reach denominator counted outstanding
 * plan parts (#515).
 *
 * Those rows claim the goal's whole work arrived while a live code part still
 * owed a merge. They cannot be corrected: the desk must re-derive the arrival
 * once every owed part is confirmed, just as `repairPartRefGoals` discards an
 * arrival filed under a part ref. The composition root supplies the goal refs
 * from its cross-domain plan query; this module only writes its own table.
 * Unconditional and idempotent because the fixed fold can never write another
 * partial goal arrival.
 */
export function dropPartialGoalArrivals(db: Database.Database, goalRefs: readonly string[]): void {
  if (goalRefs.length === 0) return;
  const remove = db.prepare(`DELETE FROM goal_arrivals WHERE goal_ref=?`);
  db.transaction((refs: readonly string[]) => {
    for (const goalRef of refs) remove.run(goalRef);
  })(goalRefs);
}

export class EnvironmentStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Attribute a merge commit to the goal it was work for.
   *
   * `OR IGNORE`, not `OR REPLACE`: the pull request has already merged, so its
   * landing is a settled fact and a second sighting of it in the closed window is
   * the same fact arriving again. Replacing would move `recordedAt` forward every
   * pulse for six hours, which is the one column anything downstream orders by.
   */
  recordGoalLanding(input: { prNumber: number; goalRef: string; sha: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO goal_landings (pr_number, goal_ref, sha, recorded_at)
         VALUES (@prNumber, @goalRef, @sha, @recordedAt)`,
      )
      .run({ ...input, recordedAt: this.ctx.now() });
  }

  /** Every landing, oldest first — the order the prober works through them in. */
  listGoalLandings(): GoalLanding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM goal_landings ORDER BY recorded_at ASC, pr_number ASC`)
      .all() as LandingRow[];
    return rows.map((r) => ({ prNumber: r.pr_number, goalRef: r.goal_ref, sha: r.sha, recordedAt: r.recorded_at }));
  }

  /**
   * The pull requests already attributed. Unbounded in age on purpose and cheap
   * for it, exactly as `BranchReapStore.reapedPrs` is: without it the sweep would
   * re-attribute every merged pull request on every pulse it stayed in the closed
   * window.
   */
  landedPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM goal_landings`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }

  /**
   * Record what a probe said. `OR REPLACE` here, unlike a landing: a verdict is an
   * observation of something that moves, and the newest one is the answer.
   */
  recordEnvironmentReach(input: {
    sha: string;
    environment: string;
    status: EnvironmentReachStatus;
    detail: string | null;
  }): void {
    this.ctx.db
      .prepare(
        `INSERT OR REPLACE INTO environment_reach (sha, environment, status, detail, observed_at)
         VALUES (@sha, @environment, @status, @detail, @observedAt)`,
      )
      .run({ ...input, observedAt: this.ctx.now() });
  }

  /**
   * Record that a goal's whole work was first seen in an environment.
   *
   * `OR IGNORE`, not `OR REPLACE`: a goal that grows another pull request, lands
   * it and is confirmed again has not arrived twice. Replacing would move
   * `arrived_at` forward and — worse — clear the announcement stamp, so the
   * ticket would collect a comment per later merge.
   */
  recordGoalArrival(input: { goalRef: string; environment: string; arrivedAt: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO goal_arrivals (goal_ref, environment, arrived_at, recorded_at, announced_at)
         VALUES (@goalRef, @environment, @arrivedAt, @recordedAt, NULL)`,
      )
      .run({ ...input, recordedAt: this.ctx.now() });
  }

  /** Every arrival, newest first — the order the cockpit's signals read them in. */
  listGoalArrivals(): GoalArrival[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM goal_arrivals ORDER BY arrived_at DESC, environment ASC`)
      .all() as ArrivalRow[];
    return rows.map((r) => ({
      goalRef: r.goal_ref,
      environment: r.environment,
      arrivedAt: r.arrived_at,
      announcedAt: r.announced_at,
      watchedAt: r.watched_at,
    }));
  }

  /**
   * Stamp an arrival as considered by the watch pass.
   *
   * {@link markArrivalAnnounced}'s twin, and called on the same terms: whether or
   * not a window was opened. That is the whole of how a deployment that adds a
   * `watch` to an environment it has been probing for a month watches its *next*
   * arrival rather than opening a window on every goal already in the table.
   */
  markArrivalWatched(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE goal_arrivals SET watched_at=? WHERE goal_ref=? AND environment=?`)
      .run(this.ctx.now(), goalRef, environment);
  }

  /**
   * Stamp an arrival as announced.
   *
   * Called whether or not anything went out, which is the whole of how an
   * environment that grows `arrival.comment` next month comments on its next
   * arrival rather than on every one already in the table.
   */
  markArrivalAnnounced(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE goal_arrivals SET announced_at=? WHERE goal_ref=? AND environment=?`)
      .run(this.ctx.now(), goalRef, environment);
  }

  /**
   * The operator's "this one is not waiting on an environment", replacing any
   * standing release on the same goal — a second click is them looking again, and
   * the newer note is the live account of why.
   */
  releaseEnvironmentGate(goalRef: string, note: string): EnvironmentGateRelease {
    const release: EnvironmentGateRelease = { goalRef, note, releasedAt: this.ctx.now() };
    this.ctx.db
      .prepare(
        `INSERT OR REPLACE INTO environment_gate_releases (goal_ref, note, released_at)
         VALUES (@goalRef, @note, @releasedAt)`,
      )
      .run(release);
    return release;
  }

  /** Put the goal back to waiting. A delete, so "not released" has exactly one shape. */
  clearEnvironmentGateRelease(goalRef: string): void {
    this.ctx.db.prepare(`DELETE FROM environment_gate_releases WHERE goal_ref=?`).run(goalRef);
  }

  /** Every standing release. Bounded by the goals an operator has said do not ship. */
  listEnvironmentGateReleases(): EnvironmentGateRelease[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM environment_gate_releases ORDER BY released_at DESC`)
      .all() as ReleaseRow[];
    return rows.map((r) => ({ goalRef: r.goal_ref, note: r.note, releasedAt: r.released_at }));
  }

  /** Every verdict held. One row per landing per environment, so it is bounded by the two. */
  listEnvironmentReach(): EnvironmentReading[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM environment_reach`).all() as ReachRow[];
    return rows.map((r) => ({
      sha: r.sha,
      environment: r.environment,
      status: r.status as EnvironmentReachStatus,
      detail: r.detail,
      observedAt: r.observed_at,
    }));
  }
}

interface LandingRow {
  pr_number: number;
  goal_ref: string;
  sha: string;
  recorded_at: string;
}

interface ArrivalRow {
  goal_ref: string;
  environment: string;
  arrived_at: string;
  recorded_at: string;
  announced_at: string | null;
  watched_at: string | null;
}

interface ReleaseRow {
  goal_ref: string;
  note: string;
  released_at: string;
}

interface ReachRow {
  sha: string;
  environment: string;
  status: string;
  detail: string | null;
  observed_at: string;
}
