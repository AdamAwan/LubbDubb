import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { ACTIVE_TASK_STATUS_SQL } from '../tasks.js';
import type { Task } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const TASK_COLUMNS: ColumnMigrations = {
  tasks: {
    origin_title: 'TEXT',
    origin_summary: 'TEXT',
    dispatch_reason: 'TEXT',
    rule: 'TEXT',
    /** A JSON array of check names — see {@link Task.ciChecks}. */
    ci_checks: 'TEXT',
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
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'status'
      | 'agentId'
      | 'originTitle'
      | 'originSummary'
      | 'dispatchReason'
      | 'rule'
      | 'ciChecks'
    > & {
      status?: Task['status'];
      // Origin context is optional at creation (issue #17): the rule dispatcher
      // supplies it, but callers that don't have it default to null.
      originTitle?: string | null;
      originSummary?: string | null;
      dispatchReason?: string | null;
      // What kind of work this is, and which checks it answers. Optional for the
      // same reason: a dispatch composed outside a rule has neither.
      rule?: string | null;
      ciChecks?: string[] | null;
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
      rule: input.rule ?? null,
      ciChecks: input.ciChecks ?? null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO tasks (id, kind, title, prompt, branch, origin_ref, origin_title, origin_summary, dispatch_reason, rule, ci_checks, status, agent_id, created_at, updated_at)
         VALUES (@id, @kind, @title, @prompt, @branch, @originRef, @originTitle, @originSummary, @dispatchReason, @rule, @ciChecks, @status, @agentId, @createdAt, @updatedAt)`,
      )
      // The array is the only field the row shape and the domain shape disagree
      // about, so it is serialised here rather than the whole task being mapped.
      .run({ ...task, ciChecks: task.ciChecks === null ? null : JSON.stringify(task.ciChecks) });
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
  rule: string | null;
  ci_checks: string | null;
  status: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Which rule a historical PR dispatch came from, read off the origin it claimed.
 *
 * Structural, not prose: these four origins are minted by exactly one rule each
 * (`src/dispatcher/rules/prCiFailing.ts`), so the mapping is a fact about the
 * dispatch vocabulary rather than a guess. Safe to re-run — it fills a null with
 * the same answer every time.
 */
const RULE_OF_ORIGIN: readonly [RegExp, string][] = [
  [/^pr:\d+:ci$/, 'pr-ci-failing'],
  [/^pr:\d+:ci-gate$/, 'pr-ci-gate'],
  [/^pr:\d+:comments$/, 'pr-review-comment'],
  [/^pr:\d+:mergeable$/, 'pr-base-update'],
];

/**
 * The two sentences `ciDispatchReason` and `gateDispatchReason` write, which
 * named the failing checks before `ci_checks` existed to hold them.
 */
const CHECKS_IN_REASON = [/has failing CI \(([^)]+)\)/, /waiting on an action \(([^)]+)\)/];

/**
 * Seed `rule` and `ci_checks` on the tasks dispatched before those columns did.
 *
 * **The only place a dispatch reason is ever parsed, and it runs once per row.**
 * Re-reading that prose on the *read* path is the defect `ciStatusOf`'s
 * one-matcher rule exists to prevent — a reader that re-derives a format reports
 * zero, silently, the first time the wording changes. Here the risk is bounded
 * and visible instead: a sentence this does not recognise leaves the row null,
 * the by-check table counts it as unattributed, and the panel says how much of
 * the CI spend that is. The read path parses nothing.
 *
 * Only fills nulls, so it is idempotent and cannot overwrite a value the
 * dispatcher recorded properly.
 */
export function backfillTaskDispatchKind(db: Database.Database): void {
  const rows = db
    .prepare(`SELECT id, origin_ref, dispatch_reason FROM tasks WHERE rule IS NULL AND ci_checks IS NULL`)
    .all() as { id: string; origin_ref: string | null; dispatch_reason: string | null }[];
  if (rows.length === 0) return;

  const update = db.prepare(`UPDATE tasks SET rule=@rule, ci_checks=@ciChecks WHERE id=@id`);
  const run = db.transaction((batch: typeof rows) => {
    for (const row of batch) {
      const rule =
        row.origin_ref === null ? null : (RULE_OF_ORIGIN.find(([re]) => re.test(row.origin_ref!))?.[1] ?? null);
      const names =
        row.dispatch_reason === null
          ? null
          : (CHECKS_IN_REASON.map((re) => re.exec(row.dispatch_reason!)?.[1]).find((m) => m !== undefined) ?? null);
      const checks = names === null ? null : names.split(', ').filter((n) => n.length > 0);
      if (rule === null && checks === null) continue;
      update.run({ id: row.id, rule, ciChecks: checks === null ? null : JSON.stringify(checks) });
    }
  });
  run(rows);
}

/**
 * A stored `ci_checks` array, or null for the tasks that carry none.
 *
 * Tolerant of a row that holds something else entirely, because this column is
 * the one thing in the table a *backfill* wrote: a read that threw would take the
 * whole cockpit down over an accounting field, which is never the trade. A
 * malformed value reads as "no detail", the same as an old row.
 */
function parseChecks(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const names = parsed.filter((n): n is string => typeof n === 'string');
    return names.length > 0 ? names : null;
  } catch {
    return null;
  }
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
    rule: r.rule,
    ciChecks: parseChecks(r.ci_checks),
    status: r.status as Task['status'],
    agentId: r.agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
