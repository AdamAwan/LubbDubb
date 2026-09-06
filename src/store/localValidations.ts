import { randomUUID } from 'node:crypto';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';
import type { LocalValidation, LocalValidationFinding, LocalValidationStatus } from '../types.js';

// → docs/spec/14-persistence.md

export const LOCAL_VALIDATION_COLUMNS: ColumnMigrations = {
  local_validations: {},
};

const OPEN: LocalValidationStatus[] = ['pending', 'dispatched'];
const OPEN_SQL = `(${OPEN.map((s) => `'${s}'`).join(', ')})`;

export class LocalValidationStore {
  constructor(private readonly ctx: StoreContext) {}

  createLocalValidation(input: {
    originRef: string;
    runId: string;
    ref: string;
    commit: string | null;
  }): LocalValidation {
    const now = this.ctx.now();
    const row: LocalValidation = {
      id: randomUUID(),
      originRef: input.originRef,
      runId: input.runId,
      ref: input.ref,
      commit: input.commit,
      status: 'pending',
      requestedAt: now,
      dispatchedAt: null,
      endedAt: null,
      taskId: null,
      fixTaskId: null,
      plan: null,
      summary: null,
      findings: [],
      visited: [],
      screenshots: [],
      note: null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO local_validations (id, origin_ref, run_id, ref, commit_sha, status, requested_at,
           dispatched_at, ended_at, task_id, fix_task_id, plan, summary, findings, visited, screenshots, note)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, NULL, NULL, '[]', '[]', '[]', NULL)`,
      )
      .run(row.id, row.originRef, row.runId, row.ref, row.commit, row.requestedAt);
    return row;
  }

  getLocalValidation(id: string): LocalValidation | null {
    const row = this.ctx.db.prepare(`SELECT * FROM local_validations WHERE id = ?`).get(id) as Row | undefined;
    return row ? toLocalValidation(row) : null;
  }

  latestLocalValidation(originRef: string): LocalValidation | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM local_validations WHERE origin_ref = ? ORDER BY requested_at DESC LIMIT 1`)
      .get(originRef) as Row | undefined;
    return row ? toLocalValidation(row) : null;
  }

  listLatestLocalValidations(): LocalValidation[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM local_validations WHERE id IN (
           SELECT id FROM local_validations lv
             WHERE lv.requested_at = (SELECT MAX(requested_at) FROM local_validations
                                        WHERE origin_ref = lv.origin_ref)
         )`,
      )
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  listOpenLocalValidations(): LocalValidation[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM local_validations WHERE status IN ${OPEN_SQL} ORDER BY requested_at`)
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  listLocalValidationsAwaitingFix(): LocalValidation[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM local_validations WHERE status = 'failed' AND fix_task_id IS NULL AND findings != '[]'
           ORDER BY ended_at`,
      )
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  markLocalValidationDispatched(id: string, taskId: string): void {
    this.ctx.db
      .prepare(
        `UPDATE local_validations SET status = 'dispatched', dispatched_at = ?, task_id = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(this.ctx.now(), taskId, id);
  }

  markLocalValidationFix(id: string, taskId: string): void {
    this.ctx.db
      .prepare(`UPDATE local_validations SET fix_task_id = ? WHERE id = ? AND fix_task_id IS NULL`)
      .run(taskId, id);
  }

  setLocalValidationPlan(id: string, plan: string): void {
    this.ctx.db.prepare(`UPDATE local_validations SET plan = ? WHERE id = ? AND status IN ${OPEN_SQL}`).run(plan, id);
  }

  recordLocalValidationReport(
    id: string,
    result: {
      status: Extract<LocalValidationStatus, 'passed' | 'failed' | 'blocked'>;
      summary: string;
      findings: LocalValidationFinding[];
      visited: string[];
      screenshots: string[];
      note: string | null;
    },
  ): LocalValidation | null {
    const info = this.ctx.db
      .prepare(
        `UPDATE local_validations SET status = ?, summary = ?, findings = ?, visited = ?, screenshots = ?,
           note = ?, ended_at = ? WHERE id = ? AND status IN ${OPEN_SQL}`,
      )
      .run(
        result.status,
        result.summary,
        JSON.stringify(result.findings),
        JSON.stringify(result.visited),
        JSON.stringify(result.screenshots),
        result.note,
        this.ctx.now(),
        id,
      );
    return info.changes === 0 ? null : this.getLocalValidation(id);
  }

  abandonLocalValidation(id: string, note: string): LocalValidation | null {
    const info = this.ctx.db
      .prepare(
        `UPDATE local_validations SET status = 'abandoned', note = ?, ended_at = ? WHERE id = ? AND status IN ${OPEN_SQL}`,
      )
      .run(note, this.ctx.now(), id);
    return info.changes === 0 ? null : this.getLocalValidation(id);
  }
}

interface Row {
  id: string;
  origin_ref: string;
  run_id: string;
  ref: string;
  commit_sha: string | null;
  status: string;
  requested_at: string;
  dispatched_at: string | null;
  ended_at: string | null;
  task_id: string | null;
  fix_task_id: string | null;
  plan: string | null;
  summary: string | null;
  findings: string | null;
  visited: string | null;
  screenshots: string | null;
  note: string | null;
}

const STATUSES: LocalValidationStatus[] = ['pending', 'dispatched', 'passed', 'failed', 'blocked', 'abandoned'];

function parseList<T>(raw: string | null): T[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function toLocalValidation(row: Row): LocalValidation {
  return {
    id: row.id,
    originRef: row.origin_ref,
    runId: row.run_id,
    ref: row.ref,
    commit: row.commit_sha,
    status: STATUSES.includes(row.status as LocalValidationStatus)
      ? (row.status as LocalValidationStatus)
      : 'abandoned',
    requestedAt: row.requested_at,
    dispatchedAt: row.dispatched_at,
    endedAt: row.ended_at,
    taskId: row.task_id,
    fixTaskId: row.fix_task_id,
    plan: row.plan,
    summary: row.summary,
    findings: parseList<LocalValidationFinding>(row.findings),
    visited: parseList<string>(row.visited),
    screenshots: parseList<string>(row.screenshots),
    note: row.note,
  };
}
