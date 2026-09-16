import { nanoid } from 'nanoid';
import type { GoalCriteriaVersion } from '../types.js';
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

  /** The whole chain, oldest first. What the goal page draws behind the current one. */
  listCriteriaVersions(originRef: string): GoalCriteriaVersion[] {
    const rows = this.ctx
      .prep(`SELECT * FROM goal_criteria WHERE origin_ref=? ORDER BY version ASC`)
      .all(originRef) as CriteriaRow[];
    return rows.map(rowToVersion);
  }
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
