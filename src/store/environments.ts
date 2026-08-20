import type { EnvironmentReachStatus, EnvironmentReading, GoalLanding } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * Two tables, one question: `goal_landings` — the commit each of a goal's pull
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
 * The tables are new, so they need no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added later will.
 * → `docs/spec/23-environments.md`
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

interface ReachRow {
  sha: string;
  environment: string;
  status: string;
  detail: string | null;
  observed_at: string;
}
