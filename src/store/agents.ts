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

  /**
   * Stamp (or clear) the moment an agent was seen working *after* it parked.
   * Separate from {@link updateAgent} because it is deliberately not part of the
   * status patch: this records an observation about a park, and folding it in
   * would invite callers to set it alongside a status they think it implies.
   */
  setAgentResumed(id: string, at: string | null): void {
    this.ctx.db.prepare(`UPDATE agents SET resumed_at=? WHERE id=?`).run(at, id);
  }

  /**
   * Count one automatic re-attach after a mid-run crash, returning the new total
   * (issue #318). Incremented in SQL over a `COALESCE`, so a row written before
   * the column existed counts from zero rather than staying null forever.
   *
   * Never cleared. The budget is the agent's whole life, not its current launch:
   * a reset on progress would let an agent that crashes once per turn resume
   * without limit, which is the loop the bound exists to stop.
   */
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

  /**
   * The same rows {@link sumUsageCostSince} totals, oldest first and unaggregated
   * — for the reader that needs *when* rather than *how much*.
   *
   * Bucketing is left to the caller rather than done in SQL: the windows a reader
   * wants are its own business, and a `strftime` grouping here would fix one
   * shape of answer in the store and force the next one to be a second query.
   */
  listUsageEventsSince(sinceIso: string): UsageEvent[] {
    const rows = this.ctx.db
      .prepare(`SELECT agent_id, cost_usd, at FROM usage_events WHERE at >= ? ORDER BY at`)
      .all(sinceIso) as { agent_id: string; cost_usd: number; at: string }[];
    return rows.map((r) => ({ agentId: r.agent_id, costUsd: r.cost_usd, at: r.at }));
  }

  /**
   * The agents dispatched on the named tasks, newest first.
   *
   * Takes task ids rather than a goal, for {@link listFilesForAgents}' reason:
   * the whole table is the read this exists to avoid, and which tasks belong to a
   * goal is the tasks store's question. An empty list reads nothing at all.
   */
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

  /**
   * Every path the agents on one goal have written: `agent_files` joined out
   * through `agents` to the task whose origin says which goal it was working,
   * one row per path and newest first.
   *
   * **Scoped by the goal's subtree** — the `issue:<n>` root and its `:plan`,
   * `:appraisal`, `:assess`, `:retro` and `:part:<slug>` arms, which is the
   * population `padOriginFor` already resolves. Asked as a prefix rather than
   * re-derived from a second taxonomy, so this cannot drift from the pad's
   * membership. The ref is `issue:<n>`, so it carries no `LIKE` wildcards.
   *
   * **Code tasks only**, `detectFileOverlaps`'s narrowing for its reason: a desk
   * agent works in a scratch directory, so a retro's `write-up.md` is not a file
   * the repository has. Listing it under a heading about where a goal's code
   * lives would be a *false* statement rather than a stale one.
   *
   * **One row per path, dated by the last write.** The row is already deduped per
   * (agent, path) with its stamp bumped on rewrite, so the newest row for a path
   * is the one that dates it, and the origin returned is whose that write was.
   * Ties break on `rowid` so the same database renders the same list twice.
   */
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

  /**
   * Which **other** goals have already been in `paths`, and what each one's
   * retrospective said — {@link listGoalFiles}'s join with a goal on the far side
   * of it rather than the near one (issue #354, phase 2).
   *
   * **"Closed" is spelled `has a retrospective`, and that is not a shortcut.** An
   * issue's open/closed state is a *world* fact, and the briefing this feeds
   * refuses those on principle: pasted into a prompt it would be a stale second
   * reading of something `world_read` answers properly. A retrospective is a row
   * this database owns, written by rule `issue-retro` only once a goal is done —
   * so it is the harness's own stored answer to the same question, and it is also
   * the thing being handed over. The gate and the payload are one join.
   *
   * **The liveness test is dropped, not inverted.** `detectFileOverlaps` scopes to
   * concurrently-live agents because it is answering "is this happening now"; this
   * asks who has been here before. A goal still being worked is excluded anyway, by
   * the retrospective gate rather than by a second liveness predicate — one reading
   * of "finished", not two.
   *
   * **Code tasks only, and the subtree is a prefix**, both {@link listGoalFiles}'s
   * rules for its reasons. The prefix is built from `retrospectives.origin_ref`,
   * which is always the `issue:<n>` root (`retroSubmitOrigin` resolves it), so it
   * carries no `LIKE` wildcards and `issue:1` never reaches `issue:12`.
   *
   * **No ranking.** Neighbours come back by the recency of their last write and
   * ties break on the ref, which is a stored timestamp and a stored key. Ordering
   * them by how many paths they share would be a relevance score — the second
   * opinion about somebody else's work that `priorWork.ts` and `retroDossier` both
   * refuse — so the count is stated by the reader and never sorts the list.
   */
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
    // Folded here rather than with a `group_concat`, because a path is arbitrary
    // text and any separator that joins it is one a path may contain.
    const byGoal = new Map<string, GoalNeighbour>();
    for (const row of rows) {
      const seen = byGoal.get(row.goal_ref);
      if (seen) seen.sharedPaths.push(row.path);
      // Rows arrive newest-first, so the first one for a goal is the write that
      // dates it and insertion order is the order the caller renders.
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

  /**
   * Every recorded file written by the named agents, newest first — the overlap
   * detector's feed.
   *
   * Takes the agent ids rather than answering the whole table, because the whole
   * table is what it used to answer: `agent_files` grows for the life of a
   * deployment and nothing ever deletes from it, so an unbounded read here was a
   * cost the snapshot paid on every poll for a reading only concurrent agents can
   * contribute to. The caller names the window
   * (`OVERLAP_AGENT_WINDOW` in `src/fileOverlap.ts`); an empty list reads nothing
   * at all.
   */
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
    // Null on every row written before the columns existed, which is the truth
    // there: those runs measured a gross figure and nothing about its cache
    // share. Not defaulted to 0 — that would report a 0% hit rate for history
    // that was never measured.
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    numTurns: r.num_turns,
    note: r.note,
    notedAt: r.noted_at,
    resumedAt: r.resumed_at,
    // Null on every row written before the column existed — read as "never resumed".
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
