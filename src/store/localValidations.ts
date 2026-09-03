import { randomUUID } from 'node:crypto';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';
import type { LocalValidation, LocalValidationFinding, LocalValidationStatus } from '../types.js';

/**
 * A brand-new table still declares its migrations, empty.
 *
 * A table being new **once** does not keep it exempt
 * ([14](../../docs/spec/14-persistence.md#migrations)), and `local_runs` is the
 * standing example of what the omission costs: it shipped without an entry, and the
 * six usage columns added to it a change later were invisible on every database
 * that predated them. The entry being here is what makes the next column an edit
 * rather than a decision.
 */
export const LOCAL_VALIDATION_COLUMNS: ColumnMigrations = {
  local_validations: {},
};

/** The statuses that mean nobody has answered yet, as SQL derived from one list. */
const OPEN: LocalValidationStatus[] = ['pending', 'dispatched'];
const OPEN_SQL = `(${OPEN.map((s) => `'${s}'`).join(', ')})`;

/**
 * The `local_validations` table: each time the fleet was asked to drive the
 * machine's dev environment and say whether a goal's changes work.
 *
 * **Rows are kept**, `local_runs`' rule: a validation that was abandoned because
 * somebody swapped the environment is exactly the case an operator hits, and its
 * reason has to be readable afterwards. The goal's page draws the latest row
 * whatever it says.
 *
 * **Every terminal write is guarded on the row still being open**, in the SQL rather
 * than in the caller. Three things can end a row — the agent reporting, the desk
 * sweeping up after a stopped environment, and the operator calling it off — and
 * they race by construction: a sweep runs on the same pulse a report arrives on.
 * Guarding in the statement makes the first writer the only writer, so an
 * `abandoned` row can never be overwritten by a reading taken against the
 * environment that went away.
 */
export class LocalValidationStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Record a request, pinned to the run it was made against.
   *
   * The pin is the argument: `runId` and `commit` are what everything later compares
   * the live environment to, so they are written here — at the one moment the caller
   * has actually looked at the run — rather than resolved again when a report
   * arrives.
   */
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

  /** The goal's most recent request, whatever became of it — what the goal page draws. */
  latestLocalValidation(originRef: string): LocalValidation | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM local_validations WHERE origin_ref = ? ORDER BY requested_at DESC LIMIT 1`)
      .get(originRef) as Row | undefined;
    return row ? toLocalValidation(row) : null;
  }

  /**
   * The latest row for every goal that has one, for the snapshot.
   *
   * One query rather than one per goal: the snapshot is built on every heartbeat and
   * every `dirty`, so a per-issue read would be a query per goal per beat for a
   * feature most goals have never used.
   */
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

  /** Everything nobody has answered yet — what the rule proposes for and the desk sweeps. */
  listOpenLocalValidations(): LocalValidation[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM local_validations WHERE status IN ${OPEN_SQL} ORDER BY requested_at`)
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  /**
   * Failed readings nothing has been dispatched to fix.
   *
   * `fix_task_id IS NULL` is the whole latch: one failure buys one fix, and a fix
   * that crashed is not retried behind the operator's back. They press the button
   * again, which is the same decision they made the first time.
   */
  listLocalValidationsAwaitingFix(): LocalValidation[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM local_validations WHERE status = 'failed' AND fix_task_id IS NULL AND findings != '[]'
           ORDER BY ended_at`,
      )
      .all() as Row[];
    return rows.map(toLocalValidation);
  }

  /**
   * Mark that an agent actually spawned for this row.
   *
   * Guarded on `pending`, which is what makes "one agent per row" a property of the
   * store rather than of the rule: the rule proposes every pulse until something
   * takes, and the executor calls this only once the session is really up.
   */
  markLocalValidationDispatched(id: string, taskId: string): void {
    this.ctx.db
      .prepare(
        `UPDATE local_validations SET status = 'dispatched', dispatched_at = ?, task_id = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(this.ctx.now(), taskId, id);
  }

  /** Latch the fix dispatch onto a failed row. */
  markLocalValidationFix(id: string, taskId: string): void {
    this.ctx.db
      .prepare(`UPDATE local_validations SET fix_task_id = ? WHERE id = ? AND fix_task_id IS NULL`)
      .run(taskId, id);
  }

  /**
   * Record the test plan. The one write that does not end the row — it lands while
   * the environment is still coming up, which is the whole point of asking for it
   * first.
   */
  setLocalValidationPlan(id: string, plan: string): void {
    this.ctx.db.prepare(`UPDATE local_validations SET plan = ? WHERE id = ? AND status IN ${OPEN_SQL}`).run(plan, id);
  }

  /**
   * Write the reading, or answer null because something else settled the row first.
   *
   * The null is the caller's cue rather than a failure: a report that arrives after
   * a sweep abandoned the row has to be told, because the agent is about to finish
   * believing it recorded something.
   */
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

  /** Settle an open row that will never be answered, with the reason on it. */
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

/**
 * A JSON column read back, or the empty list.
 *
 * Unparseable reads as empty rather than throwing: the column is written by this
 * module alone, so a bad value means a hand-edited database, and the safe direction
 * there is a row that draws with nothing in it rather than a snapshot that cannot
 * be built at all.
 */
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
    // `rowToCheck`'s narrowing: a status this build does not recognise reads as
    // `abandoned` rather than as itself, because every other value would put a row
    // back in front of the dispatcher.
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
