import { nanoid } from 'nanoid';
import type { Remedy, RemedyInput, RemedyKind } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class RemedyStore {
  constructor(private readonly ctx: StoreContext) {}

  recordRemedy(input: RemedyInput): Remedy {
    const existing = this.findSameClaim(input);
    const ts = this.ctx.now();
    if (existing) {
      this.ctx.db.prepare(`UPDATE remedies SET updated_at=? WHERE id=?`).run(ts, existing.id);
      return { ...existing, updatedAt: ts };
    }
    const remedy: Remedy = { id: `rmd_${nanoid(10)}`, ...input, createdAt: ts, updatedAt: ts };
    this.ctx.db
      .prepare(
        `INSERT INTO remedies (id, kind, origin_ref, pr_number, cause, guard, summary, checks, agent_id, task_id, created_at, updated_at)
         VALUES (@id, @kind, @originRef, @prNumber, @cause, @guard, @summary, @checks, @agentId, @taskId, @createdAt, @updatedAt)`,
      )
      .run({ ...remedy, checks: remedy.checks.length === 0 ? null : JSON.stringify(remedy.checks) });
    return remedy;
  }

  private findSameClaim(input: RemedyInput): Remedy | null {
    const row = this.ctx.db
      .prepare(
        `SELECT * FROM remedies
         WHERE task_id=? AND cause=? AND guard=? AND summary=?
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(input.taskId, input.cause, input.guard, input.summary) as RemedyRow | undefined;
    return row ? rowToRemedy(row) : null;
  }

  listRemediesSince(since: string): Remedy[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM remedies WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC`)
      .all(since) as RemedyRow[];
    return rows.map(rowToRemedy);
  }

  listRecentRemedies(kind: RemedyKind, limit: number): Remedy[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM remedies WHERE kind=? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(kind, limit) as RemedyRow[];
    return rows.map(rowToRemedy);
  }
}

interface RemedyRow {
  id: string;
  kind: string;
  origin_ref: string;
  pr_number: number;
  cause: string;
  guard: string;
  summary: string;
  checks: string | null;
  agent_id: string;
  task_id: string;
  created_at: string;
  updated_at: string;
}

function rowToRemedy(r: RemedyRow): Remedy {
  return {
    id: r.id,
    kind: r.kind as Remedy['kind'],
    originRef: r.origin_ref,
    prNumber: r.pr_number,
    cause: r.cause as Remedy['cause'],
    guard: r.guard as Remedy['guard'],
    summary: r.summary,
    checks: parseChecks(r.checks),
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseChecks(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
