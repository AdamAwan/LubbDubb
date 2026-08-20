import type {
  EnvironmentGateRelease,
  EnvironmentReachStatus,
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
} from '../types.js';
import type { StoreContext } from './context.js';

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
 * The tables are new, so they need no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added later will.
 * → `docs/spec/24-environments.md`
 */
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
    }));
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
