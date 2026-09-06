import { nanoid } from 'nanoid';
import type {
  Agent,
  AgentFile,
  AgentFileInput,
  AgentFlag,
  AgentFlagInput,
  AgentUsage,
  GoalFile,
  GoalNeighbour,
  UsageEvent,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const AGENT_COLUMNS: ColumnMigrations = {
  agents: {
    session_id: 'TEXT',
    cost_usd: 'REAL',
    input_tokens: 'INTEGER',
    output_tokens: 'INTEGER',
    cache_read_tokens: 'INTEGER',
    cache_creation_tokens: 'INTEGER',
    num_turns: 'INTEGER',
    note: 'TEXT',
    noted_at: 'TEXT',
    resumed_at: 'TEXT',
    resume_attempts: 'INTEGER',
  },
};

export class AgentStore {
  constructor(private readonly ctx: StoreContext) {}

  createAgent(input: {
    taskId: string;
    cwd: string;
    pid: number | null;
    status?: Agent['status'];
    sessionId?: string | null;
  }): Agent {
    const agent: Agent = {
      id: `agent_${nanoid(10)}`,
      taskId: input.taskId,
      status: input.status ?? 'starting',
      cwd: input.cwd,
      pid: input.pid,
      waitingReason: null,
      sessionId: input.sessionId ?? null,
      startedAt: this.ctx.now(),
      endedAt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      numTurns: null,
      note: null,
      notedAt: null,
      resumedAt: null,
      resumeAttempts: 0,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO agents (id, task_id, status, cwd, pid, waiting_reason, session_id, started_at, ended_at)
         VALUES (@id, @taskId, @status, @cwd, @pid, @waitingReason, @sessionId, @startedAt, @endedAt)`,
      )
      .run(agent);
    return agent;
  }

  updateAgent(id: string, patch: Partial<Pick<Agent, 'status' | 'pid' | 'waitingReason' | 'endedAt'>>): void {
    const existing = this.getAgent(id);
    if (!existing) throw new Error(`Agent ${id} not found`);
    const next = { ...existing, ...patch };
    this.ctx.db
      .prepare(
        `UPDATE agents SET status=@status, pid=@pid, waiting_reason=@waitingReason, ended_at=@endedAt WHERE id=@id`,
      )
      .run({ id, status: next.status, pid: next.pid, waitingReason: next.waitingReason, endedAt: next.endedAt });
  }

  setAgentResumed(id: string, at: string | null): void {
    this.ctx.db.prepare(`UPDATE agents SET resumed_at=? WHERE id=?`).run(at, id);
  }

  countAgentResumeAttempt(id: string): number {
    const row = this.ctx.db
      .prepare(`UPDATE agents SET resume_attempts=COALESCE(resume_attempts,0)+1 WHERE id=? RETURNING resume_attempts`)
      .get(id) as { resume_attempts: number } | undefined;
    if (!row) throw new Error(`Agent ${id} not found`);
    return row.resume_attempts;
  }

  getAgent(id: string): Agent | null {
    const row = this.ctx.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM agents ORDER BY started_at DESC`).all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  recordAgentUsage(id: string, usage: AgentUsage): void {
    const existing = this.getAgent(id);
    if (!existing) throw new Error(`Agent ${id} not found`);
    const next = {
      costUsd: usage.costUsd ?? existing.costUsd,
      inputTokens: usage.inputTokens ?? existing.inputTokens,
      outputTokens: usage.outputTokens ?? existing.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? existing.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens ?? existing.cacheCreationTokens,
      numTurns: usage.numTurns ?? existing.numTurns,
    };
    this.ctx.db
      .prepare(
        `UPDATE agents SET cost_usd=@costUsd, input_tokens=@inputTokens, output_tokens=@outputTokens,
                cache_read_tokens=@cacheReadTokens, cache_creation_tokens=@cacheCreationTokens,
                num_turns=@numTurns WHERE id=@id`,
      )
      .run({ id, ...next });
    const delta = Math.max(0, (usage.costUsd ?? 0) - (existing.costUsd ?? 0));
    if (delta > 0) {
      this.ctx.db
        .prepare(`INSERT INTO usage_events (agent_id, cost_usd, at) VALUES (?,?,?)`)
        .run(id, delta, this.ctx.now());
    }
  }

  recordAgentNote(id: string, note: string): string {
    const at = this.ctx.now();
    const changed = this.ctx.db.prepare(`UPDATE agents SET note=?, noted_at=? WHERE id=?`).run(note, at, id).changes;
    if (changed === 0) throw new Error(`Agent ${id} not found`);
    return at;
  }

  sumUsageCostSince(sinceIso: string): number {
    const row = this.ctx.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE at >= ?`)
      .get(sinceIso) as { total: number };
    return row.total;
  }

  listUsageEventsSince(sinceIso: string): UsageEvent[] {
    const rows = this.ctx.db
      .prepare(`SELECT agent_id, cost_usd, at FROM usage_events WHERE at >= ? ORDER BY at`)
      .all(sinceIso) as { agent_id: string; cost_usd: number; at: string }[];
    return rows.map((r) => ({ agentId: r.agent_id, costUsd: r.cost_usd, at: r.at }));
  }

  listAgentsForTasks(taskIds: readonly string[]): Agent[] {
    if (taskIds.length === 0) return [];
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM agents WHERE task_id IN (${taskIds.map(() => '?').join(', ')})
         ORDER BY started_at DESC`,
      )
      .all(...taskIds) as AgentRow[];
    return rows.map(rowToAgent);
  }

  listAgentsByStatus(...statuses: Agent['status'][]): Agent[] {
    return this.listAgents().filter((a) => statuses.includes(a.status));
  }

  countLiveAgents(): number {
    return this.listAgentsByStatus('starting', 'running', 'waiting').length;
  }

  recordFlag(agentId: string, input: AgentFlagInput): AgentFlag {
    const existing = this.ctx.db
      .prepare(`SELECT id FROM agent_flags WHERE agent_id=? AND ref=?`)
      .get(agentId, input.ref) as { id: string } | undefined;
    const flag: AgentFlag = {
      id: existing?.id ?? `flag_${nanoid(10)}`,
      agentId,
      kind: input.kind,
      label: input.label,
      ref: input.ref,
      createdAt: this.ctx.now(),
    };
    this.ctx.db
      .prepare(
        `INSERT INTO agent_flags (id, agent_id, kind, label, ref, created_at)
         VALUES (@id, @agentId, @kind, @label, @ref, @createdAt)
         ON CONFLICT(agent_id, ref) DO UPDATE SET kind=excluded.kind, label=excluded.label, created_at=excluded.created_at`,
      )
      .run(flag);
    return flag;
  }

  getFlag(id: string): AgentFlag | null {
    const row = this.ctx.db.prepare(`SELECT * FROM agent_flags WHERE id=?`).get(id) as AgentFlagRow | undefined;
    return row ? rowToFlag(row) : null;
  }

  listFlags(agentId: string): AgentFlag[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM agent_flags WHERE agent_id=? ORDER BY created_at ASC`)
      .all(agentId) as AgentFlagRow[];
    return rows.map(rowToFlag);
  }

  listAllFlags(): AgentFlag[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM agent_flags ORDER BY created_at DESC, rowid DESC`)
      .all() as AgentFlagRow[];
    return rows.map(rowToFlag);
  }

  recordFile(agentId: string, input: AgentFileInput): AgentFile {
    const existing = this.ctx.db
      .prepare(`SELECT id FROM agent_files WHERE agent_id=? AND path=?`)
      .get(agentId, input.path) as { id: string } | undefined;
    const file: AgentFile = {
      id: existing?.id ?? `file_${nanoid(10)}`,
      agentId,
      path: input.path,
      tool: input.tool,
      promoted: input.promoted,
      createdAt: this.ctx.now(),
    };
    this.ctx.db
      .prepare(
        `INSERT INTO agent_files (id, agent_id, path, tool, promoted, created_at)
         VALUES (@id, @agentId, @path, @tool, @promoted, @createdAt)
         ON CONFLICT(agent_id, path) DO UPDATE SET tool=excluded.tool, promoted=excluded.promoted, created_at=excluded.created_at`,
      )
      .run({ ...file, promoted: file.promoted ? 1 : 0 });
    return file;
  }

  listFiles(agentId: string): AgentFile[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM agent_files WHERE agent_id=? ORDER BY created_at ASC`)
      .all(agentId) as AgentFileRow[];
    return rows.map(rowToFile);
  }

  listGoalFiles(goalRef: string): GoalFile[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT path, origin_ref, created_at FROM (
           SELECT f.path AS path, t.origin_ref AS origin_ref, f.created_at AS created_at,
                  ROW_NUMBER() OVER (PARTITION BY f.path ORDER BY f.created_at DESC, f.rowid DESC) AS rn
           FROM agent_files f
           JOIN agents a ON a.id = f.agent_id
           JOIN tasks t ON t.id = a.task_id
           WHERE t.kind = 'code' AND (t.origin_ref = ? OR t.origin_ref LIKE ?)
         )
         WHERE rn = 1
         ORDER BY created_at DESC, path ASC`,
      )
      .all(goalRef, `${goalRef}:%`) as { path: string; origin_ref: string; created_at: string }[];
    return rows.map((r) => ({ path: r.path, originRef: r.origin_ref, createdAt: r.created_at }));
  }

  listGoalNeighbours(goalRef: string, paths: string[]): GoalNeighbour[] {
    if (paths.length === 0) return [];
    const holes = paths.map(() => '?').join(',');
    const rows = this.ctx.db
      .prepare(
        `SELECT r.origin_ref AS goal_ref, r.summary AS summary, f.path AS path,
                MAX(f.created_at) AS created_at
           FROM agent_files f
           JOIN agents a ON a.id = f.agent_id
           JOIN tasks t ON t.id = a.task_id
           JOIN retrospectives r
             ON t.origin_ref = r.origin_ref OR t.origin_ref LIKE r.origin_ref || ':%'
          WHERE t.kind = 'code' AND r.origin_ref <> ? AND f.path IN (${holes})
          GROUP BY r.origin_ref, f.path
          ORDER BY created_at DESC, r.origin_ref ASC, f.path ASC`,
      )
      .all(goalRef, ...paths) as { goal_ref: string; summary: string; path: string; created_at: string }[];
    const byGoal = new Map<string, GoalNeighbour>();
    for (const row of rows) {
      const seen = byGoal.get(row.goal_ref);
      if (seen) seen.sharedPaths.push(row.path);
      else
        byGoal.set(row.goal_ref, {
          goalRef: row.goal_ref,
          retroSummary: row.summary,
          sharedPaths: [row.path],
          lastWriteAt: row.created_at,
        });
    }
    return [...byGoal.values()];
  }

  listFilesForAgents(agentIds: readonly string[]): AgentFile[] {
    if (agentIds.length === 0) return [];
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM agent_files WHERE agent_id IN (${agentIds.map(() => '?').join(',')})
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...agentIds) as AgentFileRow[];
    return rows.map(rowToFile);
  }
}

interface AgentRow {
  id: string;
  task_id: string;
  status: string;
  cwd: string;
  pid: number | null;
  waiting_reason: string | null;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  num_turns: number | null;
  note: string | null;
  noted_at: string | null;
  resumed_at: string | null;
  resume_attempts: number | null;
}
interface AgentFlagRow {
  id: string;
  agent_id: string;
  kind: string;
  label: string;
  ref: string;
  created_at: string;
}
interface AgentFileRow {
  id: string;
  agent_id: string;
  path: string;
  tool: string | null;
  promoted: number;
  created_at: string;
}

function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as Agent['status'],
    cwd: r.cwd,
    pid: r.pid,
    waitingReason: r.waiting_reason,
    sessionId: r.session_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    costUsd: r.cost_usd,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    numTurns: r.num_turns,
    note: r.note,
    notedAt: r.noted_at,
    resumedAt: r.resumed_at,
    resumeAttempts: r.resume_attempts ?? 0,
  };
}
function rowToFlag(r: AgentFlagRow): AgentFlag {
  return {
    id: r.id,
    agentId: r.agent_id,
    kind: r.kind,
    label: r.label,
    ref: r.ref,
    createdAt: r.created_at,
  };
}
function rowToFile(r: AgentFileRow): AgentFile {
  return {
    id: r.id,
    agentId: r.agent_id,
    path: r.path,
    tool: r.tool,
    promoted: !!r.promoted,
    createdAt: r.created_at,
  };
}
