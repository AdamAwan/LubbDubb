import type {
  EnvironmentGateRelease,
  EnvironmentHealthReading,
  EnvironmentHealthState,
  EnvironmentHealthTier,
  EnvironmentReachStatus,
  EnvironmentReading,
  GoalArrival,
  GoalLanding,
} from '../types.js';
import type Database from 'better-sqlite3';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

export const ENVIRONMENT_COLUMNS: ColumnMigrations = {
  goal_arrivals: { watched_at: 'TEXT' },
};

export function repairPartRefGoals(db: Database.Database): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE goal_landings SET goal_ref = substr(goal_ref, 1, instr(goal_ref, ':part:') - 1)
       WHERE goal_ref LIKE 'issue:%:part:%'`,
    ).run();
    db.prepare(`DELETE FROM goal_arrivals WHERE goal_ref LIKE 'issue:%:part:%'`).run();
  })();
}

export function dropPartialGoalArrivals(db: Database.Database, goalRefs: readonly string[]): void {
  if (goalRefs.length === 0) return;
  const remove = db.prepare(`DELETE FROM goal_arrivals WHERE goal_ref=?`);
  db.transaction((refs: readonly string[]) => {
    for (const goalRef of refs) remove.run(goalRef);
  })(goalRefs);
}

export class EnvironmentStore {
  constructor(private readonly ctx: StoreContext) {}

  recordGoalLanding(input: { prNumber: number; goalRef: string; sha: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO goal_landings (pr_number, goal_ref, sha, recorded_at)
         VALUES (@prNumber, @goalRef, @sha, @recordedAt)`,
      )
      .run({ ...input, recordedAt: this.ctx.now() });
  }

  listGoalLandings(): GoalLanding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM goal_landings ORDER BY recorded_at ASC, pr_number ASC`)
      .all() as LandingRow[];
    return rows.map((r) => ({ prNumber: r.pr_number, goalRef: r.goal_ref, sha: r.sha, recordedAt: r.recorded_at }));
  }

  landedPrs(): ReadonlySet<number> {
    const rows = this.ctx.db.prepare(`SELECT pr_number FROM goal_landings`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }

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

  recordGoalArrival(input: { goalRef: string; environment: string; arrivedAt: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO goal_arrivals (goal_ref, environment, arrived_at, recorded_at, announced_at)
         VALUES (@goalRef, @environment, @arrivedAt, @recordedAt, NULL)`,
      )
      .run({ ...input, recordedAt: this.ctx.now() });
  }

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

  markArrivalWatched(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE goal_arrivals SET watched_at=? WHERE goal_ref=? AND environment=?`)
      .run(this.ctx.now(), goalRef, environment);
  }

  markArrivalAnnounced(goalRef: string, environment: string): void {
    this.ctx.db
      .prepare(`UPDATE goal_arrivals SET announced_at=? WHERE goal_ref=? AND environment=?`)
      .run(this.ctx.now(), goalRef, environment);
  }

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

  clearEnvironmentGateRelease(goalRef: string): void {
    this.ctx.db.prepare(`DELETE FROM environment_gate_releases WHERE goal_ref=?`).run(goalRef);
  }

  listEnvironmentGateReleases(): EnvironmentGateRelease[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM environment_gate_releases ORDER BY released_at DESC`)
      .all() as ReleaseRow[];
    return rows.map((r) => ({ goalRef: r.goal_ref, note: r.note, releasedAt: r.released_at }));
  }

  recordEnvironmentHealth(input: {
    environment: string;
    state: EnvironmentHealthState;
    tier: EnvironmentHealthTier | null;
    reasons: string[];
    detail: string | null;
  }): void {
    this.ctx.db
      .prepare(
        `INSERT INTO environment_health (environment, state, tier, reasons, detail, observed_at, changed_at)
         VALUES (@environment, @state, @tier, @reasons, @detail, @at, @at)
         ON CONFLICT(environment) DO UPDATE SET
           state=excluded.state, tier=excluded.tier, reasons=excluded.reasons,
           detail=excluded.detail, observed_at=excluded.observed_at,
           changed_at = CASE
             WHEN environment_health.state = excluded.state
              AND ifnull(environment_health.tier, '') = ifnull(excluded.tier, '')
             THEN environment_health.changed_at ELSE excluded.changed_at END`,
      )
      .run({
        environment: input.environment,
        state: input.state,
        tier: input.tier,
        reasons: JSON.stringify(input.reasons),
        detail: input.detail,
        at: this.ctx.now(),
      });
  }

  listEnvironmentHealth(): EnvironmentHealthReading[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM environment_health`).all() as HealthRow[];
    return rows.map((r) => ({
      environment: r.environment,
      state: r.state as EnvironmentHealthState,
      tier: r.tier as EnvironmentHealthTier | null,
      reasons: readReasons(r.reasons),
      detail: r.detail,
      observedAt: r.observed_at,
      changedAt: r.changed_at,
    }));
  }

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

interface HealthRow {
  environment: string;
  state: string;
  tier: string | null;
  reasons: string;
  detail: string | null;
  observed_at: string;
  changed_at: string;
}

function readReasons(text: string): string[] {
  try {
    const json: unknown = JSON.parse(text);
    return Array.isArray(json) ? json.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

interface ReachRow {
  sha: string;
  environment: string;
  status: string;
  detail: string | null;
  observed_at: string;
}
