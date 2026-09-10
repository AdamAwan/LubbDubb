import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { ACTIVE_TASK_STATUS_SQL } from '../tasks.js';
import type { ExtraMcpServer, Task, TaskSummary } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const TASK_COLUMNS: ColumnMigrations = {
  tasks: {
    origin_title: 'TEXT',
    origin_summary: 'TEXT',
    dispatch_reason: 'TEXT',
    rule: 'TEXT',
    ci_checks: 'TEXT',
    model: 'TEXT',
    effort: 'TEXT',
    permission_mode: 'TEXT',
    profile: 'TEXT',
    profile_source: 'TEXT',
    mcp_servers: 'TEXT',
  },
};

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
      | 'mcpServers'
      | 'model'
      | 'effort'
      | 'permissionMode'
      | 'profile'
      | 'profileSource'
    > & {
      status?: Task['status'];
      originTitle?: string | null;
      originSummary?: string | null;
      dispatchReason?: string | null;
      rule?: string | null;
      ciChecks?: string[] | null;
      mcpServers?: ExtraMcpServer[] | null;
      model?: string | null;
      effort?: string | null;
      permissionMode?: string | null;
      profile?: string | null;
      profileSource?: string | null;
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
      mcpServers: input.mcpServers ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? null,
      profile: input.profile ?? null,
      profileSource: input.profileSource ?? null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO tasks (id, kind, title, prompt, branch, origin_ref, origin_title, origin_summary, dispatch_reason, rule, ci_checks, mcp_servers, model, effort, permission_mode, profile, profile_source, status, agent_id, created_at, updated_at)
         VALUES (@id, @kind, @title, @prompt, @branch, @originRef, @originTitle, @originSummary, @dispatchReason, @rule, @ciChecks, @mcpServers, @model, @effort, @permissionMode, @profile, @profileSource, @status, @agentId, @createdAt, @updatedAt)`,
      )
      .run({
        ...task,
        ciChecks: task.ciChecks === null ? null : JSON.stringify(task.ciChecks),
        mcpServers: task.mcpServers === null ? null : JSON.stringify(task.mcpServers),
      });
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

  listTasks(): TaskSummary[] {
    const rows = this.ctx.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM tasks ORDER BY created_at DESC`)
      .all() as TaskSummaryRow[];
    return rows.map(rowToSummary);
  }

  listGoalTasks(goalRef: string, prRefs: readonly string[]): TaskSummary[] {
    const under = `${goalRef.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`;
    const inPrs = prRefs.length > 0 ? ` OR origin_ref IN (${prRefs.map(() => '?').join(', ')})` : '';
    const rows = this.ctx.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM tasks
          WHERE origin_ref = ? OR origin_ref LIKE ? ESCAPE '\\'${inPrs}
          ORDER BY created_at DESC`,
      )
      .all(goalRef, under, ...prRefs) as TaskSummaryRow[];
    return rows.map(rowToSummary);
  }

  countTasksNamingTools(since: string, names: readonly string[]): Map<string, number> {
    if (names.length === 0) return new Map();
    const columns = names.map((_, i) => `SUM(CASE WHEN instr(prompt, ?) > 0 THEN 1 ELSE 0 END) AS n${i}`).join(', ');
    const row = this.ctx.db
      .prepare(`SELECT ${columns} FROM tasks WHERE created_at >= ?`)
      .get(...names, since) as Record<string, number | null>;
    return new Map(names.map((name, i) => [name, row[`n${i}`] ?? 0]));
  }

  listOutstandingTasks(): Task[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE status IN ${ACTIVE_TASK_STATUS_SQL} ORDER BY created_at ASC`)
      .all() as TaskRow[];
    return rows.map(rowToTask);
  }

  findActiveTaskByOrigin(originRef: string): Task | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE origin_ref=? AND status IN ${ACTIVE_TASK_STATUS_SQL} LIMIT 1`)
      .get(originRef) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  findActiveTaskByBranch(branch: string): Task | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE branch=? AND status IN ${ACTIVE_TASK_STATUS_SQL} LIMIT 1`)
      .get(branch) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }
}

const SUMMARY_COLUMNS = [
  'id',
  'kind',
  'title',
  'branch',
  'origin_ref',
  'origin_title',
  'origin_summary',
  'dispatch_reason',
  'rule',
  'ci_checks',
  'mcp_servers',
  'model',
  'effort',
  'permission_mode',
  'profile',
  'profile_source',
  'status',
  'agent_id',
  'created_at',
  'updated_at',
].join(', ');

interface TaskSummaryRow {
  id: string;
  kind: string;
  title: string;
  branch: string | null;
  origin_ref: string | null;
  origin_title: string | null;
  origin_summary: string | null;
  dispatch_reason: string | null;
  rule: string | null;
  ci_checks: string | null;
  mcp_servers: string | null;
  model: string | null;
  effort: string | null;
  permission_mode: string | null;
  profile: string | null;
  profile_source: string | null;
  status: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow extends TaskSummaryRow {
  prompt: string;
}

const RULE_OF_ORIGIN: readonly [RegExp, string][] = [
  [/^pr:\d+:ci$/, 'pr-ci-failing'],
  [/^pr:\d+:ci-gate$/, 'pr-ci-gate'],
  [/^pr:\d+:comments$/, 'pr-review-comment'],
  [/^pr:\d+:mergeable$/, 'pr-base-update'],
];

const CHECKS_IN_REASON = [/has failing CI \(([^)]+)\)/, /waiting on an action \(([^)]+)\)/];

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

function parseMcpServers(raw: string | null): ExtraMcpServer[] | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const servers = parsed.filter(
      (s): s is ExtraMcpServer =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as ExtraMcpServer).key === 'string' &&
        typeof (s as ExtraMcpServer).command === 'string' &&
        Array.isArray((s as ExtraMcpServer).args),
    );
    return servers.length > 0 ? servers : null;
  } catch {
    return null;
  }
}

function rowToTask(r: TaskRow): Task {
  return { ...rowToSummary(r), prompt: r.prompt };
}

function rowToSummary(r: TaskSummaryRow): TaskSummary {
  return {
    id: r.id,
    kind: r.kind as Task['kind'],
    title: r.title,
    branch: r.branch,
    originRef: r.origin_ref,
    originTitle: r.origin_title,
    originSummary: r.origin_summary,
    dispatchReason: r.dispatch_reason,
    rule: r.rule,
    ciChecks: parseChecks(r.ci_checks),
    mcpServers: parseMcpServers(r.mcp_servers),
    model: r.model,
    effort: r.effort,
    permissionMode: r.permission_mode ?? null,
    profile: r.profile ?? null,
    profileSource: r.profile_source ?? null,
    status: r.status as Task['status'],
    agentId: r.agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
