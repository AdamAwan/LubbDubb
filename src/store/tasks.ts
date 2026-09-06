import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';
import { ACTIVE_TASK_STATUS_SQL } from '../tasks.js';
import type { ExtraMcpServer, Task, TaskSummary } from '../types.js';
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
    /** The resolved `claude --model` value for this run — see {@link Task.model}. */
    model: 'TEXT',
    /** The resolved `claude --effort` level for this run — see {@link Task.effort}. */
    effort: 'TEXT',
    /** Which profile that pair came from — see {@link Task.profile}. */
    profile: 'TEXT',
    /** Which level of the precedence chain named it — see {@link Task.profileSource}. */
    profile_source: 'TEXT',
    /** A JSON array of ExtraMcpServer — see {@link Task.mcpServers}. */
    mcp_servers: 'TEXT',
  },
};

/**
 * The `tasks` table: what the harness has claimed and is doing something about.
 *
 * The three active-task readings below are one predicate asked three ways and must
 * keep sharing `ACTIVE_TASK_STATUS_SQL`: a fourth spelling out the status set by
 * hand is a second answer to the origin/branch gate every dispatch passes.
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
      | 'mcpServers'
      | 'model'
      | 'effort'
      | 'profile'
      | 'profileSource'
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
      mcpServers?: ExtraMcpServer[] | null;
      // The model this run launches on, and the depth it runs at, resolved from
      // one `agentModels` profile at dispatch. Optional for the same reason: a
      // caller with no policy to consult has neither.
      model?: string | null;
      effort?: string | null;
      // Which profile that pair came from, and which level of the precedence
      // chain named it. Optional on the same terms, and stored rather than
      // re-derived: config moves, and a run has to keep saying what it launched on.
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
      profile: input.profile ?? null,
      profileSource: input.profileSource ?? null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO tasks (id, kind, title, prompt, branch, origin_ref, origin_title, origin_summary, dispatch_reason, rule, ci_checks, mcp_servers, model, effort, profile, profile_source, status, agent_id, created_at, updated_at)
         VALUES (@id, @kind, @title, @prompt, @branch, @originRef, @originTitle, @originSummary, @dispatchReason, @rule, @ciChecks, @mcpServers, @model, @effort, @profile, @profileSource, @status, @agentId, @createdAt, @updatedAt)`,
      )
      // The array is the only field the row shape and the domain shape disagree
      // about, so it is serialised here rather than the whole task being mapped.
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

  /**
   * Every task the harness has ever claimed, newest first — **without the
   * prompts**, which is the whole reason this is not `SELECT *`: prompts are
   * kilobytes each, no list reader wants them, and better-sqlite3 is synchronous, so
   * a starred read blocks the server for hundreds of ms. Anything that needs a
   * prompt reads its one row with {@link getTask}.
   */
  listTasks(): TaskSummary[] {
    const rows = this.ctx.db
      .prepare(`SELECT ${SUMMARY_COLUMNS} FROM tasks ORDER BY created_at DESC`)
      .all() as TaskSummaryRow[];
    return rows.map(rowToSummary);
  }

  /**
   * The tasks dispatched on one goal — its own ref, anything under it
   * (`issue:12:part:signer`), and the pull requests the caller names as the goal's.
   * Newest first, prompts left behind as {@link listTasks} leaves them. The pull
   * requests are named by the caller rather than resolved here, so this cannot
   * disagree with the cockpit's own `ownsPr` match.
   */
  listGoalTasks(goalRef: string, prRefs: readonly string[]): TaskSummary[] {
    // `goalRef` is `issue:<n>` on every call, but a LIKE pattern built from an
    // argument is escaped rather than trusted to stay that way.
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

  /**
   * Per name, how many tasks dispatched inside the window have that name in their
   * **prompt** — the evidence behind the MCP usage reading's "nothing named it".
   * Matched in SQL as one scan so the prompts never leave the database.
   *
   * `instr` is a plain substring match, and the looser form is the safe direction:
   * over-matching says a tool *was* named, and "nothing named it" is the verdict it
   * would be wrong to raise falsely. The window is on the task's own `created_at` —
   * when agents were told something — not on the run instant the other insights
   * folds use.
   */
  countTasksNamingTools(since: string, names: readonly string[]): Map<string, number> {
    if (names.length === 0) return new Map();
    const columns = names.map((_, i) => `SUM(CASE WHEN instr(prompt, ?) > 0 THEN 1 ELSE 0 END) AS n${i}`).join(', ');
    const row = this.ctx.db
      .prepare(`SELECT ${columns} FROM tasks WHERE created_at >= ?`)
      .get(...names, since) as Record<string, number | null>;
    return new Map(names.map((name, i) => [name, row[`n${i}`] ?? 0]));
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
   * Is there already an active (queued/running/waiting) task on this branch? The
   * mirror of {@link findActiveTaskByOrigin} and the enforcement half of the
   * origin↔branch 1:1 property: rule `manual-job`'s operator-supplied branch is the
   * one path where the two diverge, and without this two live agents share one
   * reuse-first worktree directory.
   */
  findActiveTaskByBranch(branch: string): Task | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM tasks WHERE branch=? AND status IN ${ACTIVE_TASK_STATUS_SQL} LIMIT 1`)
      .get(branch) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }
}

/**
 * The columns {@link TaskStore.listTasks} reads — every one the table has except
 * `prompt`, spelled out so the bulk text cannot come back by accident. A column
 * added to {@link TASK_COLUMNS} and not added here reads back as undefined rather
 * than erroring; `test/snapshotShape.test.ts` holds the list to the domain type.
 */
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
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  mcp_servers: string | null;
  model: string | null;
  effort: string | null;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  profile: string | null;
  profile_source: string | null;
  status: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A whole row, for the single-row reads that hand back a {@link Task}. */
interface TaskRow extends TaskSummaryRow {
  prompt: string;
}

/**
 * Which rule a historical PR dispatch came from, read off the origin it claimed.
 * Backfill only — the dispatcher records `rule` itself, and nothing on the write
 * path reads this. `pr:<n>:mergeable` is no longer exact: `pr-base-update` and
 * `pr-base-update-conflict` were one rule when these rows were written, so a
 * historical conflict resolution is attributed to `pr-base-update`.
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
 * **The only place a dispatch reason is ever parsed**, once per row — the read path
 * must never re-derive it. An unrecognised sentence leaves the row null and the
 * panel counts it as unattributed. Fills nulls only, so it is idempotent.
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
 * A stored `ci_checks` array, or null for the tasks that carry none. Tolerant of a
 * malformed row — this column was backfill-written, and a throw here would take the
 * cockpit down over an accounting field; it reads as "no detail" instead.
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

/**
 * The extra MCP servers a row recorded, or null. Every entry is checked for the
 * three fields a launch needs, since a half-written server reaches `--mcp-config`
 * with an undefined command; an unreadable row reports none, which launches the
 * agent on the harness's channel alone.
 */
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
    profile: r.profile ?? null,
    profileSource: r.profile_source ?? null,
    status: r.status as Task['status'],
    agentId: r.agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
