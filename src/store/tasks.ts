import { nanoid } from 'nanoid';
import { ACTIVE_TASK_STATUS_SQL } from '../tasks.js';
import type { Task } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const TASK_COLUMNS: ColumnMigrations = {
  tasks: {
    origin_title: 'TEXT',
    origin_summary: 'TEXT',
    dispatch_reason: 'TEXT',
  },
};

/**
 * The `tasks` table: what the harness has claimed and is doing something about.
 *
 * The three active-task readings below are one predicate asked three ways — as a
 * list, by origin and by branch — and they share `ACTIVE_TASK_STATUS_SQL` for
 * that reason. They are the origin/branch gate every dispatch passes, so a fourth
 * that spelled the status set out by hand would be a second answer to the
 * question the other three agree on.
 */
export class TaskStore {
  constructor(private readonly ctx: StoreContext) {}

  createTask(
    input: Omit<
      Task,
      'id' | 'createdAt' | 'updatedAt' | 'status' | 'agentId' | 'originTitle' | 'originSummary' | 'dispatchReason'
    > & {
      status?: Task['status'];
      // Origin context is optional at creation (issue #17): the rule dispatcher
      // supplies it, but callers that don't have it default to null.
      originTitle?: string | null;
      originSummary?: string | null;
      dispatchReason?: string | null;
    },
  ): Task {
    const ts = this.ctx.now();
    const task: Task = {
      id: `task_${nanoid(10)}`,
      status: input.status ?? 'queued',
      agentId: null,
      createdAt: ts,
      updatedAt: ts,
      kind: input.kind,
      title: input.title,
      prompt: input.prompt,
      branch: input.branch,
      originRef: input.originRef,
      originTitle: input.originTitle ?? null,
      originSummary: input.originSummary ?? null,
      dispatchReason: input.dispatchReason ?? null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO tasks (id, kind, title, prompt, branch, origin_ref, origin_title, origin_summary, dispatch_reason, status, agent_id, created_at, updated_at)
         VALUES (@id, @kind, @title, @prompt, @branch, @originRef, @originTitle, @originSummary, @dispatchReason, @status, @agentId, @createdAt, @updatedAt)`,
      )
      .run(task);
    return task;
  }

  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'agentId' | 'branch'>>): void {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    const next = { ...existing, ...patch, updatedAt: this.ctx.now() };
    this.ctx.db
      .prepare(`UPDATE tasks SET status=@status, agent_id=@agentId, branch=@branch, updated_at=@updatedAt WHERE id=@id`)
      .run({ id, status: next.status, agentId: next.agentId, branch: next.branch, updatedAt: next.updatedAt });
  }

  getTask(id: string): Task | null {
    const row = this.ctx.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(): Task[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /**
   * Every task whose work is still outstanding — the same `queued`/`running`/`waiting`
   * set the two `findActiveTask*` gates below treat as active, asked as a list rather
   * than as a lookup. Crash recovery is the caller: an outstanding task with no agent
   * row behind it is work the harness is holding a claim on and doing nothing about.
   */
  listOutstandingTasks(): Task[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE status IN ${ACTIVE_TASK_STATUS_SQL} ORDER BY created_at ASC`)
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Is there already an active (queued/running/waiting) task for this origin? */
  findActiveTaskByOrigin(originRef: string): Task | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE origin_ref=? AND status IN ${ACTIVE_TASK_STATUS_SQL} LIMIT 1`)
      .get(originRef) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  /**
   * Is there already an active (queued/running/waiting) task on this branch?
   *
   * The mirror of {@link findActiveTaskByOrigin}, and the enforcement half of the
   * origin↔branch 1:1 property (issue #116). For every world-driven rule the two
   * are the same question, so this never fires for one; rule `manual-job`'s operator-supplied
   * branch is the one dispatch path where they can diverge, and
   * `WorktreeManager.ensure` is reuse-first — so without this, two live agents
   * share one worktree directory with no merge anywhere to reconcile them.
   */
  findActiveTaskByBranch(branch: string): Task | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE branch=? AND status IN ${ACTIVE_TASK_STATUS_SQL} LIMIT 1`)
      .get(branch) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }
}

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  branch: string | null;
  origin_ref: string | null;
  origin_title: string | null;
  origin_summary: string | null;
  dispatch_reason: string | null;
  status: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    kind: r.kind as Task['kind'],
    title: r.title,
    prompt: r.prompt,
    branch: r.branch,
    originRef: r.origin_ref,
    originTitle: r.origin_title,
    originSummary: r.origin_summary,
    dispatchReason: r.dispatch_reason,
    status: r.status as Task['status'],
    agentId: r.agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
