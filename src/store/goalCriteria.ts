import { nanoid } from 'nanoid';
import type { GoalCriteriaDrift, GoalCriteriaVersion } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md#goal-criteria-are-append-only

/**
 * `goal_criteria`. Append-only: an edit is a new version pointing at the one it
 * supersedes, and no method here writes an `UPDATE`. The standing of a version —
 * whether it predates the plan's reveal — is derived by the caller that holds both
 * timestamps, never stored here.
 */
export class GoalCriteriaStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Appends a version. The chain is per goal and its `version` is the count so far
   * plus one, taken inside the write so two presses cannot mint the same number —
   * the `UNIQUE (origin_ref, version)` index refuses the second if they do.
   */
  appendCriteria(input: {
    originRef: string;
    text: string;
    author: string | null;
    reason: string | null;
  }): GoalCriteriaVersion {
    const write = this.ctx.db.transaction((): GoalCriteriaVersion => {
      const standing = this.currentCriteria(input.originRef);
      const version: GoalCriteriaVersion = {
        id: `crit_${nanoid(10)}`,
        originRef: input.originRef,
        version: (standing?.version ?? 0) + 1,
        supersedes: standing?.id ?? null,
        text: input.text,
        author: input.author,
        reason: input.reason,
        authoredAt: this.ctx.now(),
      };
      this.ctx
        .prep(
          `INSERT INTO goal_criteria (id, origin_ref, version, supersedes, text, author, reason, authored_at)
           VALUES (@id, @originRef, @version, @supersedes, @text, @author, @reason, @authoredAt)`,
        )
        .run(version);
      return version;
    });
    return write();
  }

  /** The newest version, or null for a goal nobody has written criteria for. */
  currentCriteria(originRef: string): GoalCriteriaVersion | null {
    const row = this.ctx
      .prep(`SELECT * FROM goal_criteria WHERE origin_ref=? ORDER BY version DESC LIMIT 1`)
      .get(originRef) as CriteriaRow | undefined;
    return row ? rowToVersion(row) : null;
  }

  /** Every goal's newest version. What the dispatcher appends to the goal's prompts. */
  listCurrentCriteria(): GoalCriteriaVersion[] {
    const rows = this.ctx
      .prep(
        `SELECT c.* FROM goal_criteria c
         JOIN (SELECT origin_ref, MAX(version) AS version FROM goal_criteria GROUP BY origin_ref) m
           ON m.origin_ref = c.origin_ref AND m.version = c.version`,
      )
      .all() as CriteriaRow[];
    return rows.map(rowToVersion);
  }

  /** The whole chain, oldest first. What the goal page draws behind the current one. */
  listCriteriaVersions(originRef: string): GoalCriteriaVersion[] {
    const rows = this.ctx
      .prep(`SELECT * FROM goal_criteria WHERE origin_ref=? ORDER BY version ASC`)
      .all(originRef) as CriteriaRow[];
    return rows.map(rowToVersion);
  }

  /**
   * Records that a goal's criteria changed after work had started.
   *
   * `goal_criteria_drift` is its own table and reaches the cockpit as its own wire
   * list, merged into the feed at the feed's door. It is emphatically **not** a
   * `WorldEvent`: `deliveryHold` expires a standing delivery verdict on any world
   * event matching the goal's issue ref, so a drift record written as one would
   * un-park the goal it just reported on and hand delivered work back to the fleet —
   * the same trap as an environment arrival and a sheet reading, one subsystem over.
   *
   * Keyed on the version it reports, so a second call over one version — a retry, a
   * re-read of the chain — writes nothing and answers with the record that stands.
   */
  recordDrift(input: {
    originRef: string;
    criteriaId: string;
    version: number;
    author: string | null;
    reason: string | null;
  }): GoalCriteriaDrift {
    const write = this.ctx.db.transaction((): GoalCriteriaDrift => {
      const standing = this.ctx.prep(`SELECT * FROM goal_criteria_drift WHERE criteria_id=?`).get(input.criteriaId) as
        | DriftRow
        | undefined;
      if (standing !== undefined) return rowToDrift(standing);
      const drift: GoalCriteriaDrift = {
        id: `drift_${nanoid(10)}`,
        originRef: input.originRef,
        criteriaId: input.criteriaId,
        version: input.version,
        author: input.author,
        reason: input.reason,
        recordedAt: this.ctx.now(),
      };
      this.ctx
        .prep(
          `INSERT INTO goal_criteria_drift (id, origin_ref, criteria_id, version, author, reason, recorded_at)
           VALUES (@id, @originRef, @criteriaId, @version, @author, @reason, @recordedAt)`,
        )
        .run(drift);
      return drift;
    });
    return write();
  }

  /** Every drift record, newest first. The feed's list. */
  listCriteriaDrift(): GoalCriteriaDrift[] {
    const rows = this.ctx
      .prep(`SELECT * FROM goal_criteria_drift ORDER BY recorded_at DESC, rowid DESC`)
      .all() as DriftRow[];
    return rows.map(rowToDrift);
  }
}

interface DriftRow {
  id: string;
  origin_ref: string;
  criteria_id: string;
  version: number;
  author: string | null;
  reason: string | null;
  recorded_at: string;
}

function rowToDrift(r: DriftRow): GoalCriteriaDrift {
  return {
    id: r.id,
    originRef: r.origin_ref,
    criteriaId: r.criteria_id,
    version: r.version,
    author: r.author,
    reason: r.reason,
    recordedAt: r.recorded_at,
  };
}

interface CriteriaRow {
  id: string;
  origin_ref: string;
  version: number;
  supersedes: string | null;
  text: string;
  author: string | null;
  reason: string | null;
  authored_at: string;
}

function rowToVersion(r: CriteriaRow): GoalCriteriaVersion {
  return {
    id: r.id,
    originRef: r.origin_ref,
    version: r.version,
    supersedes: r.supersedes,
    text: r.text,
    author: r.author,
    reason: r.reason,
    authoredAt: r.authored_at,
  };
}
