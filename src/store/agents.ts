import { nanoid } from 'nanoid';
import type { Agent, AgentFile, AgentFileInput, AgentFlag, AgentFlagInput, AgentUsage } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const AGENT_COLUMNS: ColumnMigrations = {
  agents: {
    session_id: 'TEXT',
    cost_usd: 'REAL',
    input_tokens: 'INTEGER',
    output_tokens: 'INTEGER',
    num_turns: 'INTEGER',
    note: 'TEXT',
    noted_at: 'TEXT',
    resumed_at: 'TEXT',
  },
};

/**
 * The `agents` row and the three tables that hang off it: `usage_events` (the
 * cost delta behind each rolling window), `agent_flags` (artifacts an agent
 * surfaced) and `agent_files` (every path the file-events hook saw it write).
 *
 * Together because they are written together: {@link recordAgentUsage} folds a
 * cumulative report onto the agent row *and* appends the delta in one breath, and
 * a flag or a file is meaningless without the agent it is attributed to.
 */
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
      numTurns: null,
      note: null,
      notedAt: null,
      resumedAt: null,
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

  /**
   * Stamp (or clear) the moment an agent was seen working *after* it parked.
   * Separate from {@link updateAgent} because it is deliberately not part of the
   * status patch: this records an observation about a park, and folding it in
   * would invite callers to set it alongside a status they think it implies.
   */
  setAgentResumed(id: string, at: string | null): void {
    this.ctx.db.prepare(`UPDATE agents SET resumed_at=? WHERE id=?`).run(at, id);
  }

  getAgent(id: string): Agent | null {
    const row = this.ctx.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM agents ORDER BY started_at DESC`).all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  /**
   * Fold a session's *cumulative* usage report onto the agent row, and record
   * the cost delta since the previous report as a timestamped `usage_events`
   * row — so rolling account windows (5h/7d) are a plain SUM later, with no
   * delta re-derivation.
   */
  recordAgentUsage(id: string, usage: AgentUsage): void {
    const existing = this.getAgent(id);
    if (!existing) throw new Error(`Agent ${id} not found`);
    const next = {
      costUsd: usage.costUsd ?? existing.costUsd,
      inputTokens: usage.inputTokens ?? existing.inputTokens,
      outputTokens: usage.outputTokens ?? existing.outputTokens,
      numTurns: usage.numTurns ?? existing.numTurns,
    };
    this.ctx.db
      .prepare(
        `UPDATE agents SET cost_usd=@costUsd, input_tokens=@inputTokens, output_tokens=@outputTokens, num_turns=@numTurns WHERE id=@id`,
      )
      .run({ id, ...next });
    // Clamp: a cumulative total should never regress, but a restarted CLI would
    // reset it — never let that poison the window sum with a negative delta.
    const delta = Math.max(0, (usage.costUsd ?? 0) - (existing.costUsd ?? 0));
    if (delta > 0) {
      this.ctx.db
        .prepare(`INSERT INTO usage_events (agent_id, cost_usd, at) VALUES (?,?,?)`)
        .run(id, delta, this.ctx.now());
    }
  }

  /**
   * Record an agent's own one-line account of what it is doing (`note_progress`).
   *
   * **Latest value, not a stream** — which is why this is two columns on the agent
   * row and not a table. One row per call would be an audit trail, and that audit
   * trail already exists: every call appears in the agent's transcript as a tool
   * use, in order, with everything around it for context. A second, lossier copy
   * in SQLite would answer nothing the transcript doesn't. What the transcript
   * cannot answer cheaply — from a fleet view, for eight agents at once — is
   * "where is this one up to *now*", so exactly that is stored: overwritten each
   * call, and read straight off {@link listAgents} with no new snapshot key.
   *
   * The note deliberately survives the agent: a finished agent's last note is the
   * best one-line summary of the run there is, and it costs nothing to keep.
   */
  recordAgentNote(id: string, note: string): string {
    const at = this.ctx.now();
    const changed = this.ctx.db.prepare(`UPDATE agents SET note=?, noted_at=? WHERE id=?`).run(note, at, id).changes;
    if (changed === 0) throw new Error(`Agent ${id} not found`);
    return at;
  }

  /** Total agent cost recorded since `sinceIso` — the rolling-window aggregate. */
  sumUsageCostSince(sinceIso: string): number {
    const row = this.ctx.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE at >= ?`)
      .get(sinceIso) as { total: number };
    return row.total;
  }

  listAgentsByStatus(...statuses: Agent['status'][]): Agent[] {
    return this.listAgents().filter((a) => statuses.includes(a.status));
  }

  countLiveAgents(): number {
    return this.listAgentsByStatus('starting', 'running', 'waiting').length;
  }

  // -- Flags (surfaced artifacts) ------------------------------------------

  /**
   * Record (or refresh) an artifact an agent flagged. Deduped by (agent, ref):
   * an agent re-flagging the same doc as it evolves updates the kind/label and
   * bumps the timestamp on the existing row rather than inserting a duplicate.
   * Returns the persisted flag (its stable id preserved across refreshes).
   */
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

  /** Every flag across all agents, newest first — the snapshot feed. */
  listAllFlags(): AgentFlag[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM agent_flags ORDER BY created_at DESC, rowid DESC`)
      .all() as AgentFlagRow[];
    return rows.map(rowToFlag);
  }

  // -- Files (captured by the file-events hook) ----------------------------

  /**
   * Record (or refresh) a file an agent wrote. Deduped by (agent, path): the same
   * path written again updates the tool/promotion and bumps the timestamp rather
   * than piling up rows. Returns the persisted file (stable id across refreshes).
   */
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

  /** Every recorded file across all agents, newest first — the snapshot feed. */
  listAllFiles(): AgentFile[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM agent_files ORDER BY created_at DESC, rowid DESC`)
      .all() as AgentFileRow[];
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
  num_turns: number | null;
  note: string | null;
  noted_at: string | null;
  resumed_at: string | null;
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
    numTurns: r.num_turns,
    note: r.note,
    notedAt: r.noted_at,
    resumedAt: r.resumed_at,
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
