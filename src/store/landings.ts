import { nanoid } from 'nanoid';
import type { StackLanding, StackLandingStatus } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class StackLandingStore {
  constructor(private readonly ctx: StoreContext) {}

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

  landingLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, ref FROM stack_landings WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      ref: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.ref]));
  }

  listStackLandings(limit = 50): StackLanding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM stack_landings ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as LandingRow[];
    return rows.map(rowToLanding);
  }

  listStandingLandings(): StackLanding[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM stack_landings WHERE status='standing' ORDER BY created_at DESC, rowid DESC`)
      .all() as LandingRow[];
    return rows.map(rowToLanding);
  }

  standingLandingForPr(prNumber: number): StackLanding | null {
    return this.listStandingLandings().find((l) => l.rungs.includes(prNumber)) ?? null;
  }

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
