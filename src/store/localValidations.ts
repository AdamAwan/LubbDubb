import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';
import { toRecordingStatus } from './rows/recording.js';
import type {
  LocalValidation,
  LocalValidationFinding,
  LocalValidationRequester,
  LocalValidationResult,
  LocalValidationStatus,
  RecordingStatus,
} from '../types.js';

// → docs/spec/14-persistence.md

// No backfill for `recording_status`: null is *not known*, true of every row from before the column.
// `setup` defaults to '[]', and `requested_by` to 'operator', which every row from before them truly was.
export const LOCAL_VALIDATION_COLUMNS: ColumnMigrations = {
  local_validations: {
    recording_status: 'TEXT',
    setup: "TEXT NOT NULL DEFAULT '[]'",
    requested_by: "TEXT NOT NULL DEFAULT 'operator'",
    fix_ticket_ref: 'TEXT',
  },
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
    requestedBy?: LocalValidationRequester;
  }): LocalValidation {
    const now = this.ctx.now();
    const row: LocalValidation = {
      id: randomUUID(),
      originRef: input.originRef,
      runId: input.runId,
      ref: input.ref,
      commit: input.commit,
      status: 'pending',
      requestedBy: input.requestedBy ?? 'operator',
      requestedAt: now,
      dispatchedAt: null,
      endedAt: null,
      taskId: null,
      fixTaskId: null,
      fixTicketRef: null,
      plan: null,
      summary: null,
      findings: [],
      visited: [],
      setup: [],
      screenshots: [],
      note: null,
      recordingStatus: null,
    };
    this.ctx
      .prep(
        `INSERT INTO local_validations (id, origin_ref, run_id, ref, commit_sha, status, requested_by, requested_at,
           dispatched_at, ended_at, task_id, fix_task_id, plan, summary, findings, visited, setup, screenshots, note)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, '[]', '[]', '[]', '[]', NULL)`,
      )
      .run(row.id, row.originRef, row.runId, row.ref, row.commit, row.requestedBy, row.requestedAt);
    return row;
  }

  getLocalValidation(id: string): LocalValidation | null {
    const row = this.ctx.prep(`SELECT * FROM local_validations WHERE id = ?`).get(id) as Row | undefined;
    return row ? toLocalValidation(row) : null;
  }

  latestLocalValidation(originRef: string): LocalValidation | null {
    const row = this.ctx
      .prep(`SELECT * FROM local_validations WHERE origin_ref = ? ORDER BY requested_at DESC LIMIT 1`)
      .get(originRef) as Row | undefined;
    return row ? toLocalValidation(row) : null;
  }

  listLatestLocalValidations(): LocalValidation[] {
    const rows = this.ctx
      .prep(
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
    const rows = this.ctx
      .prep(`SELECT * FROM local_validations WHERE status IN ${OPEN_SQL} ORDER BY requested_at`)
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  listLocalValidationsAwaitingFix(): LocalValidation[] {
    const rows = this.ctx
      .prep(
        `SELECT * FROM local_validations WHERE status = 'failed' AND fix_task_id IS NULL AND findings != '[]'
           ORDER BY ended_at`,
      )
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  listLocalValidationsEndedBefore(before: string): LocalValidation[] {
    const rows = this.ctx
      .prep(`SELECT * FROM local_validations WHERE ended_at IS NOT NULL AND ended_at < ?`)
      .all(before) as Row[];
    return rows.map(toLocalValidation);
  }

  setLocalValidationMedia(id: string, names: readonly string[]): void {
    this.ctx.prep(`UPDATE local_validations SET screenshots = ? WHERE id = ?`).run(JSON.stringify(names), id);
  }

  markLocalValidationDispatched(id: string, taskId: string): void {
    this.ctx
      .prep(
        `UPDATE local_validations SET status = 'dispatched', dispatched_at = ?, task_id = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(this.ctx.now(), taskId, id);
  }

  markLocalValidationFix(id: string, taskId: string): void {
    this.ctx.prep(`UPDATE local_validations SET fix_task_id = ? WHERE id = ? AND fix_task_id IS NULL`).run(taskId, id);
  }

  listLocalValidationsAwaitingTicket(ref: string): LocalValidation[] {
    const rows = this.ctx
      .prep(
        `SELECT * FROM local_validations WHERE status = 'failed' AND ref = ? AND fix_ticket_ref IS NULL
           AND findings != '[]' ORDER BY ended_at`,
      )
      .all(ref) as Row[];
    return rows.map(toLocalValidation);
  }

  claimLocalValidationTicket(id: string): boolean {
    return (
      this.ctx.prep(`UPDATE local_validations SET fix_ticket_ref = '' WHERE id = ? AND fix_ticket_ref IS NULL`).run(id)
        .changes > 0
    );
  }

  settleLocalValidationTicket(id: string, ticketRef: string | null): void {
    this.ctx
      .prep(`UPDATE local_validations SET fix_ticket_ref = ? WHERE id = ? AND fix_ticket_ref = ''`)
      .run(ticketRef, id);
  }

  setLocalValidationPlan(id: string, plan: string): void {
    this.ctx.prep(`UPDATE local_validations SET plan = ? WHERE id = ? AND status IN ${OPEN_SQL}`).run(plan, id);
  }

  recordLocalValidationReport(
    id: string,
    result: {
      status: LocalValidationResult;
      summary: string;
      findings: LocalValidationFinding[];
      visited: string[];
      setup: string[];
      screenshots: string[];
      note: string | null;
      recordingStatus: RecordingStatus | null;
    },
  ): LocalValidation | null {
    const info = this.ctx
      .prep(
        `UPDATE local_validations SET status = ?, summary = ?, findings = ?, visited = ?, setup = ?, screenshots = ?,
           note = ?, recording_status = ?, ended_at = ? WHERE id = ? AND status IN ${OPEN_SQL}`,
      )
      .run(
        result.status,
        result.summary,
        JSON.stringify(result.findings),
        JSON.stringify(result.visited),
        JSON.stringify(result.setup),
        JSON.stringify(result.screenshots),
        result.note,
        result.recordingStatus,
        this.ctx.now(),
        id,
      );
    return info.changes === 0 ? null : this.getLocalValidation(id);
  }

  abandonLocalValidation(id: string, note: string): LocalValidation | null {
    const info = this.ctx
      .prep(
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
  requested_by: string;
  requested_at: string;
  dispatched_at: string | null;
  ended_at: string | null;
  task_id: string | null;
  fix_task_id: string | null;
  fix_ticket_ref: string | null | undefined;
  plan: string | null;
  summary: string | null;
  findings: string | null;
  visited: string | null;
  setup: string;
  screenshots: string | null;
  note: string | null;
  recording_status: string | null | undefined;
}

const STATUSES: LocalValidationStatus[] = [
  'pending',
  'dispatched',
  'passed',
  'failed',
  'blocked',
  'skipped',
  'abandoned',
];

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
    requestedBy: row.requested_by === 'auto' ? 'auto' : 'operator',
    requestedAt: row.requested_at,
    dispatchedAt: row.dispatched_at,
    endedAt: row.ended_at,
    taskId: row.task_id,
    fixTaskId: row.fix_task_id,
    fixTicketRef: row.fix_ticket_ref || null,
    plan: row.plan,
    summary: row.summary,
    findings: parseList<LocalValidationFinding>(row.findings),
    visited: parseList<string>(row.visited),
    setup: parseList<string>(row.setup),
    screenshots: parseList<string>(row.screenshots),
    note: row.note,
    recordingStatus: toRecordingStatus(row.recording_status),
  };
}

export function settleTicketsFromBeforeTheColumn(db: Database.Database): void {
  db.prepare(`UPDATE local_validations SET fix_ticket_ref = '' WHERE status = 'failed'`).run();
}
