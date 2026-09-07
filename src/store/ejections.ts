import { nanoid } from 'nanoid';
import type { Ejection, EjectionInput, EjectionOutcome } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/35-ejection.md

export const EJECTION_COLUMNS: ColumnMigrations = {
  ejections: {},
};

interface Row {
  id: string;
  origin_ref: string;
  branch: string | null;
  worktree_path: string | null;
  agent_id: string;
  task_id: string;
  session_id: string | null;
  reason: string;
  ejected_at: string;
  last_seen_at: string | null;
  last_note: string | null;
  settled_at: string | null;
  outcome: string | null;
  settle_note: string | null;
}

const COLUMNS = `id, origin_ref, branch, worktree_path, agent_id, task_id, session_id, reason,
                 ejected_at, last_seen_at, last_note, settled_at, outcome, settle_note`;

export class EjectionStore {
  constructor(private readonly ctx: StoreContext) {}

  recordEjection(input: EjectionInput): Ejection {
    const ejection: Ejection = {
      id: `ejc_${nanoid(10)}`,
      originRef: input.originRef,
      branch: input.branch,
      worktreePath: input.worktreePath,
      agentId: input.agentId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      reason: input.reason,
      ejectedAt: this.ctx.now(),
      lastSeenAt: null,
      lastNote: null,
      settledAt: null,
      outcome: null,
      settleNote: null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO ejections (${COLUMNS})
         VALUES (@id, @originRef, @branch, @worktreePath, @agentId, @taskId, @sessionId, @reason,
                 @ejectedAt, @lastSeenAt, @lastNote, @settledAt, @outcome, @settleNote)`,
      )
      .run(ejection);
    return ejection;
  }

  getEjection(id: string): Ejection | null {
    const row = this.ctx.db.prepare(`SELECT ${COLUMNS} FROM ejections WHERE id=?`).get(id) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  listEjections(limit = 100): Ejection[] {
    const rows = this.ctx.db
      .prepare(`SELECT ${COLUMNS} FROM ejections ORDER BY ejected_at DESC LIMIT ?`)
      .all(limit) as Row[];
    return rows.map(hydrate);
  }

  liveEjections(): Ejection[] {
    const rows = this.ctx.db
      .prepare(`SELECT ${COLUMNS} FROM ejections WHERE settled_at IS NULL ORDER BY ejected_at ASC`)
      .all() as Row[];
    return rows.map(hydrate);
  }

  liveEjectionForOrigin(originRef: string): Ejection | null {
    const row = this.ctx.db
      .prepare(`SELECT ${COLUMNS} FROM ejections WHERE origin_ref=? AND settled_at IS NULL`)
      .get(originRef) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  ejectionOnBranch(branch: string): Ejection | null {
    const row = this.ctx.db
      .prepare(`SELECT ${COLUMNS} FROM ejections WHERE branch=? AND settled_at IS NULL`)
      .get(branch) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  noteEjection(id: string, note: string | null): void {
    const ts = this.ctx.now();
    if (note === null) {
      this.ctx.db.prepare(`UPDATE ejections SET last_seen_at=? WHERE id=? AND settled_at IS NULL`).run(ts, id);
      return;
    }
    this.ctx.db
      .prepare(`UPDATE ejections SET last_seen_at=?, last_note=? WHERE id=? AND settled_at IS NULL`)
      .run(ts, note, id);
  }

  settleEjection(id: string, outcome: EjectionOutcome, note: string | null): Ejection | null {
    const changed = this.ctx.db
      .prepare(`UPDATE ejections SET settled_at=?, outcome=?, settle_note=? WHERE id=? AND settled_at IS NULL`)
      .run(this.ctx.now(), outcome, note, id).changes;
    return changed === 0 ? null : this.getEjection(id);
  }
}

function hydrate(row: Row): Ejection {
  return {
    id: row.id,
    originRef: row.origin_ref,
    branch: row.branch,
    worktreePath: row.worktree_path,
    agentId: row.agent_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    reason: row.reason,
    ejectedAt: row.ejected_at,
    lastSeenAt: row.last_seen_at,
    lastNote: row.last_note,
    settledAt: row.settled_at,
    outcome: row.outcome as EjectionOutcome | null,
    settleNote: row.settle_note,
  };
}
