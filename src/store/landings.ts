import { nanoid } from 'nanoid';
import type { StackLanding, StackLandingStatus } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `stack_landings` table: an operator's standing authorization to land a
 * whole chain of stacked pull requests, one rung per cycle.
 *
 * The table is new, so it needs no `ColumnMigrations` entry — but a table being
 * new *once* does not keep it exempt, and a column added to it later will.
 *
 * Every lookup here keys on **PR number**, never on the stack ref. See
 * {@link StackLanding} for why: the ref is named after the bottom rung, which is
 * the first thing to merge.
 */
export class StackLandingStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record the intent, and revoke any standing one that shares a rung with it.
   *
   * The supersede is not tidiness. Two standing intents over one chain would both
   * authorize the same merge and both want settling, so "who authorized this" —
   * the question this whole path exists to keep answerable — would have two
   * answers. A second click *is* the operator looking again, so the newer record
   * is the live one and the older is revoked rather than left to race it.
   */
  recordStackLanding(ref: string, rungs: number[]): StackLanding {
    const ts = this.ctx.now();
    const overlapping = new Set(rungs);
    for (const standing of this.listStandingLandings()) {
      if (standing.rungs.some((n) => overlapping.has(n)))
        this.settleStackLanding(standing.id, 'revoked', 'superseded by a later click');
    }
    const landing: StackLanding = {
      id: `land_${nanoid(10)}`,
      ref,
      rungs,
      status: 'standing',
      reason: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO stack_landings (id, ref, rungs, status, reason, created_at, updated_at)
         VALUES (@id, @ref, @rungs, @status, @reason, @createdAt, @updatedAt)`,
      )
      .run({ ...landing, rungs: JSON.stringify(rungs) });
    return landing;
  }

  getStackLanding(id: string): StackLanding | null {
    const row = this.ctx.db.prepare(`SELECT * FROM stack_landings WHERE id=?`).get(id) as LandingRow | undefined;
    return row ? rowToLanding(row) : null;
  }

  /**
   * What each of these landings authorized, by id — the pets panel's label for a
   * `landing` origin, which is the goal the chain belonged to rather than a title
   * the row does not have. A missing id is absent from the map, never an error.
   * → `docs/spec/22-pets.md#the-sources`
   */
  landingLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, ref FROM stack_landings WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      ref: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.ref]));
  }

  /** Every intent, newest first — what the cockpit reads and what a restart re-reads. */
  listStackLandings(limit = 50): StackLanding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM stack_landings ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as LandingRow[];
    return rows.map(rowToLanding);
  }

  /** The intents that still authorize something. Unbounded: only a handful can stand at once. */
  listStandingLandings(): StackLanding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM stack_landings WHERE status='standing' ORDER BY created_at DESC, rowid DESC`)
      .all() as LandingRow[];
    return rows.map(rowToLanding);
  }

  /**
   * The standing intent that authorizes merging this PR, if one does.
   *
   * Filtered in JS rather than in SQL because the scope is a JSON array and the
   * standing set is a handful of rows — a `json_each` join would buy nothing and
   * would put the shape of the column into the query.
   */
  standingLandingForPr(prNumber: number): StackLanding | null {
    return this.listStandingLandings().find((l) => l.rungs.includes(prNumber)) ?? null;
  }

  /**
   * End an intent, one way. Guarded in the write (`WHERE ... status='standing'`)
   * rather than by a read-then-check, the same discipline `decideProposal` uses:
   * two settlements racing on one pulse settle it once, and the loser gets null
   * rather than overwriting the reason the winner recorded.
   */
  settleStackLanding(
    id: string,
    status: Exclude<StackLandingStatus, 'standing'>,
    reason: string | null,
  ): StackLanding | null {
    const updatedAt = this.ctx.now();
    const result = this.ctx.db
      .prepare(`UPDATE stack_landings SET status=?, reason=?, updated_at=? WHERE id=? AND status='standing'`)
      .run(status, reason, updatedAt, id);
    if (result.changes === 0) return null;
    return this.getStackLanding(id);
  }
}

interface LandingRow {
  id: string;
  ref: string;
  rungs: string;
  status: string;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToLanding(r: LandingRow): StackLanding {
  return {
    id: r.id,
    ref: r.ref,
    // The column is written from `JSON.stringify(number[])` one method above, so
    // this parse cannot fail on a row this build wrote. It is still narrowed
    // rather than cast: a malformed row would otherwise reach the executor as an
    // authorization scope of `undefined`, and every `includes` on it would throw
    // inside the one path that must never throw.
    rungs: readRungs(r.rungs),
    status: r.status as StackLandingStatus,
    reason: r.reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function readRungs(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : [];
  } catch {
    return [];
  }
}
