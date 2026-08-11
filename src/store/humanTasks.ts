import { nanoid } from 'nanoid';
import type { HumanTask, HumanTaskInput, HumanTaskStatus } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * `human_tasks` was a fresh `CREATE TABLE`, so it has nothing to migrate yet. The
 * entry exists anyway, empty: a table being new *once* does not keep it exempt,
 * and the next column added here has somewhere obvious to be declared rather than
 * being invisible on every database from before it existed.
 */
export const HUMAN_TASK_COLUMNS: ColumnMigrations = {
  human_tasks: {},
};

/**
 * The `human_tasks` table: work only a person can do.
 *
 * The dispatcher does not read this table, and that is the whole of the access
 * story. A human task holds work off the fleet only by *being* a plan part
 * (`part_id`), and a part is a node the reconciler and rule `plan-part` already
 * understand — so an agent that asks for one gains the ability to ask a person,
 * never the ability to stop the fleet.
 */
export class HumanTaskStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File a human task. `agentId`/`taskId`/`originRef` are the caller's own,
   * resolved from its credential by the tool layer, or all null when an operator
   * filed it from the cockpit.
   *
   * A repeat (same agent, same origin, same title) refreshes the existing row
   * rather than inserting, exactly as `recordFinding` does and for its reason: an
   * agent that asks for the same thing on every turn must not fill the operator's
   * list. The status is deliberately *not* reset — a declined task asked for
   * again stays declined, which is what declining it meant.
   */
  recordHumanTask(
    input: HumanTaskInput & {
      agentId: string | null;
      taskId: string | null;
      originRef: string | null;
      partId?: string | null;
    },
  ): { task: HumanTask; created: boolean } {
    const ts = this.ctx.now();
    // `IS` rather than `=` so a null matches a null (SQL equality doesn't).
    const existing = this.ctx.db
      .prepare(`SELECT * FROM human_tasks WHERE agent_id IS ? AND origin_ref IS ? AND title=?`)
      .get(input.agentId, input.originRef, input.title) as HumanTaskRow | undefined;
    if (existing) {
      this.ctx.db
        .prepare(`UPDATE human_tasks SET detail=?, updated_at=? WHERE id=?`)
        .run(input.detail, ts, existing.id);
      return { task: { ...rowToHumanTask(existing), detail: input.detail, updatedAt: ts }, created: false };
    }
    const task: HumanTask = {
      id: `hum_${nanoid(10)}`,
      title: input.title,
      detail: input.detail,
      originRef: input.originRef,
      partId: input.partId ?? null,
      agentId: input.agentId,
      taskId: input.taskId,
      status: 'open',
      resolution: null,
      createdAt: ts,
      updatedAt: ts,
      resolvedAt: null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO human_tasks (id, title, detail, origin_ref, part_id, agent_id, task_id, status, resolution, created_at, updated_at, resolved_at)
         VALUES (@id, @title, @detail, @originRef, @partId, @agentId, @taskId, @status, @resolution, @createdAt, @updatedAt, @resolvedAt)`,
      )
      .run(task);
    return { task, created: true };
  }

  getHumanTask(id: string): HumanTask | null {
    const row = this.ctx.db.prepare(`SELECT * FROM human_tasks WHERE id=?`).get(id) as HumanTaskRow | undefined;
    return row ? rowToHumanTask(row) : null;
  }

  /** Every human task, newest first — the snapshot feed, open ones and a settled tail alike. */
  listHumanTasks(limit = 100): HumanTask[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * The human tasks backing plan parts — what the reconciler reads to decide
   * whether a part a person owns is still waiting or has been refused.
   *
   * Every one of them, not only the open ones: `declined` is precisely the state
   * the reconciler has to see, and filtering here would hand it silence for a
   * refusal.
   */
  listHumanTasksForParts(partIds: string[]): HumanTask[] {
    if (partIds.length === 0) return [];
    const holes = partIds.map(() => '?').join(',');
    const rows = this.ctx.db
      .prepare(`SELECT * FROM human_tasks WHERE part_id IN (${holes})`)
      .all(...partIds) as HumanTaskRow[];
    return rows.map(rowToHumanTask);
  }

  /**
   * Settle a human task: the person did it, or refused it.
   *
   * Compare-and-set in the write (`WHERE id=? AND status='open'`), the same
   * discipline as `decideProposal` and `linkFindingTicket`: a second click settles
   * nothing and cannot overwrite the first verdict with the second. Returns null
   * when there was no open task to settle, which the route turns into a 409.
   */
  settleHumanTask(id: string, status: Exclude<HumanTaskStatus, 'open'>, resolution: string | null): HumanTask | null {
    const ts = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE human_tasks SET status=?, resolution=?, updated_at=?, resolved_at=? WHERE id=? AND status='open'`,
      )
      .run(status, resolution, ts, ts, id);
    if (result.changes === 0) return null;
    return this.getHumanTask(id);
  }
}

interface HumanTaskRow {
  id: string;
  title: string;
  detail: string | null;
  origin_ref: string | null;
  part_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  status: string;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function rowToHumanTask(r: HumanTaskRow): HumanTask {
  return {
    id: r.id,
    title: r.title,
    detail: r.detail,
    originRef: r.origin_ref,
    partId: r.part_id,
    agentId: r.agent_id,
    taskId: r.task_id,
    status: r.status as HumanTaskStatus,
    resolution: r.resolution,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
  };
}
