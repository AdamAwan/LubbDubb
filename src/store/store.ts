import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nanoid } from 'nanoid';
import { SCHEMA } from './schema.js';
import type { Agent, Decision, Escalation, Task, WorldEvent, WorldEventInput, WorldSnapshot } from '../types.js';

/** Injectable clock so tests are deterministic. */
export type Clock = () => string;
const systemClock: Clock = () => new Date().toISOString();

/**
 * The single persistence surface. Everything else talks to the store; nothing
 * else touches SQLite. Reads return plain domain objects; writes are synchronous
 * (better-sqlite3) which keeps the harness logic simple and race-free.
 */
export class Store {
  private readonly db: Database.Database;
  private readonly now: Clock;
  // Per-agent in-memory transcript accumulator. Output arrives as many tiny
  // deltas; buffering them into one INSERT per ~16KB avoids a DB write (plus a
  // MAX(seq) SELECT) on every chunk. Flushed on threshold, read, and close so
  // read-your-writes stays intact.
  private readonly transcriptBuffers = new Map<string, { chunks: string[]; bytes: number }>();
  private static readonly TRANSCRIPT_FLUSH_BYTES = 16384;

  constructor(dbPath: string, clock: Clock = systemClock) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.now = clock;
  }

  close(): void {
    // Persist anything still buffered before the handle goes away.
    for (const agentId of [...this.transcriptBuffers.keys()]) this.flushTranscript(agentId);
    this.db.close();
  }

  // -- Tasks ---------------------------------------------------------------

  createTask(
    input: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'agentId'> & { status?: Task['status'] },
  ): Task {
    const ts = this.now();
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
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, kind, title, prompt, branch, origin_ref, status, agent_id, created_at, updated_at)
         VALUES (@id, @kind, @title, @prompt, @branch, @originRef, @status, @agentId, @createdAt, @updatedAt)`,
      )
      .run(task);
    return task;
  }

  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'agentId' | 'branch'>>): void {
    const existing = this.getTask(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    const next = { ...existing, ...patch, updatedAt: this.now() };
    this.db
      .prepare(`UPDATE tasks SET status=@status, agent_id=@agentId, branch=@branch, updated_at=@updatedAt WHERE id=@id`)
      .run({ id, status: next.status, agentId: next.agentId, branch: next.branch, updatedAt: next.updatedAt });
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasks(): Task[] {
    const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all() as TaskRow[];
    return rows.map(rowToTask);
  }

  /** Is there already an active (queued/running/waiting) task for this origin? */
  findActiveTaskByOrigin(originRef: string): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE origin_ref=? AND status IN ('queued','running','waiting') LIMIT 1`)
      .get(originRef) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  // -- Agents --------------------------------------------------------------

  createAgent(input: { taskId: string; cwd: string; pid: number | null; status?: Agent['status'] }): Agent {
    const agent: Agent = {
      id: `agent_${nanoid(10)}`,
      taskId: input.taskId,
      status: input.status ?? 'starting',
      cwd: input.cwd,
      pid: input.pid,
      waitingReason: null,
      startedAt: this.now(),
      endedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO agents (id, task_id, status, cwd, pid, waiting_reason, started_at, ended_at)
         VALUES (@id, @taskId, @status, @cwd, @pid, @waitingReason, @startedAt, @endedAt)`,
      )
      .run(agent);
    return agent;
  }

  updateAgent(id: string, patch: Partial<Pick<Agent, 'status' | 'pid' | 'waitingReason' | 'endedAt'>>): void {
    const existing = this.getAgent(id);
    if (!existing) throw new Error(`Agent ${id} not found`);
    const next = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET status=@status, pid=@pid, waiting_reason=@waitingReason, ended_at=@endedAt WHERE id=@id`,
      )
      .run({ id, status: next.status, pid: next.pid, waitingReason: next.waitingReason, endedAt: next.endedAt });
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare(`SELECT * FROM agents ORDER BY started_at DESC`).all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  listAgentsByStatus(...statuses: Agent['status'][]): Agent[] {
    return this.listAgents().filter((a) => statuses.includes(a.status));
  }

  countLiveAgents(): number {
    return this.listAgentsByStatus('starting', 'running', 'waiting').length;
  }

  // -- Transcripts ---------------------------------------------------------

  appendTranscript(agentId: string, chunk: string): void {
    let buf = this.transcriptBuffers.get(agentId);
    if (!buf) {
      buf = { chunks: [], bytes: 0 };
      this.transcriptBuffers.set(agentId, buf);
    }
    buf.chunks.push(chunk);
    buf.bytes += Buffer.byteLength(chunk);
    if (buf.bytes >= Store.TRANSCRIPT_FLUSH_BYTES) this.flushTranscript(agentId);
  }

  /** Persist one agent's buffered transcript as a single row, preserving order. */
  flushTranscript(agentId: string): void {
    const buf = this.transcriptBuffers.get(agentId);
    if (!buf || buf.chunks.length === 0) return;
    this.transcriptBuffers.delete(agentId);
    const chunk = buf.chunks.join('');
    const seq = (
      this.db.prepare(`SELECT COALESCE(MAX(seq),-1)+1 AS n FROM agent_transcripts WHERE agent_id=?`).get(agentId) as {
        n: number;
      }
    ).n;
    this.db
      .prepare(`INSERT INTO agent_transcripts (agent_id, seq, chunk, at) VALUES (?,?,?,?)`)
      .run(agentId, seq, chunk, this.now());
  }

  getTranscript(agentId: string): string {
    // Flush first so a read always reflects every appended chunk.
    this.flushTranscript(agentId);
    const rows = this.db.prepare(`SELECT chunk FROM agent_transcripts WHERE agent_id=? ORDER BY seq`).all(agentId) as {
      chunk: string;
    }[];
    return rows.map((r) => r.chunk).join('');
  }

  // -- Escalations ---------------------------------------------------------

  createEscalation(input: Omit<Escalation, 'id' | 'status' | 'response' | 'createdAt' | 'answeredAt'>): Escalation {
    const esc: Escalation = {
      id: `esc_${nanoid(10)}`,
      status: 'open',
      response: null,
      createdAt: this.now(),
      answeredAt: null,
      type: input.type,
      prompt: input.prompt,
      context: input.context,
      agentId: input.agentId,
      taskId: input.taskId,
    };
    this.db
      .prepare(
        `INSERT INTO escalations (id, type, status, prompt, context, agent_id, task_id, response, created_at, answered_at)
         VALUES (@id, @type, @status, @prompt, @context, @agentId, @taskId, @response, @createdAt, @answeredAt)`,
      )
      .run({ ...esc, context: JSON.stringify(esc.context) });
    return esc;
  }

  answerEscalation(id: string, response: string): Escalation {
    const existing = this.getEscalation(id);
    if (!existing) throw new Error(`Escalation ${id} not found`);
    const answeredAt = this.now();
    this.db
      .prepare(`UPDATE escalations SET status='answered', response=?, answered_at=? WHERE id=?`)
      .run(response, answeredAt, id);
    return { ...existing, status: 'answered', response, answeredAt };
  }

  getEscalation(id: string): Escalation | null {
    const row = this.db.prepare(`SELECT * FROM escalations WHERE id=?`).get(id) as EscalationRow | undefined;
    return row ? rowToEscalation(row) : null;
  }

  listEscalations(): Escalation[] {
    const rows = this.db.prepare(`SELECT * FROM escalations ORDER BY created_at DESC`).all() as EscalationRow[];
    return rows.map(rowToEscalation);
  }

  listOpenEscalations(): Escalation[] {
    return this.listEscalations().filter((e) => e.status === 'open');
  }

  // -- Decisions (audit) ---------------------------------------------------

  recordDecision(input: Omit<Decision, 'id' | 'createdAt'>): Decision {
    const decision: Decision = { id: `dec_${nanoid(10)}`, createdAt: this.now(), ...input };
    this.db
      .prepare(`INSERT INTO decisions (id, cycle_id, action, outcome, detail, created_at) VALUES (?,?,?,?,?,?)`)
      .run(
        decision.id,
        decision.cycleId,
        JSON.stringify(decision.action),
        decision.outcome,
        decision.detail,
        decision.createdAt,
      );
    return decision;
  }

  listDecisions(limit = 200): Decision[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as DecisionRow[];
    return rows.map(rowToDecision);
  }

  // -- Connector persistence ----------------------------------------------

  getConnectorState(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM connector_state WHERE key=?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setConnectorState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO connector_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }

  recordConnectorEvent(kind: string, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO connector_events (id, kind, payload, created_at) VALUES (?,?,?,?)`)
      .run(`ev_${nanoid(10)}`, kind, JSON.stringify(payload), this.now());
  }

  // -- World change history ------------------------------------------------

  /** Stamp each diffed transition with an id + timestamp, persist, return rows. */
  recordWorldEvents(inputs: WorldEventInput[]): WorldEvent[] {
    const at = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO world_events (id, kind, ref, summary, created_at) VALUES (@id, @kind, @ref, @summary, @createdAt)`,
    );
    const events = inputs.map((input) => ({ id: `we_${nanoid(10)}`, createdAt: at, ...input }));
    const insertAll = this.db.transaction((rows: WorldEvent[]) => {
      for (const row of rows) stmt.run(row);
    });
    insertAll(events);
    return events;
  }

  listWorldEvents(limit = 200): WorldEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM world_events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as WorldEventRow[];
    return rows.map(rowToWorldEvent);
  }

  /** The last snapshot the harness diffed against, or null on a fresh store. */
  getWorldBaseline(): WorldSnapshot | null {
    const row = this.db.prepare(`SELECT world FROM world_baseline WHERE id=1`).get() as { world: string } | undefined;
    return row ? (JSON.parse(row.world) as WorldSnapshot) : null;
  }

  setWorldBaseline(world: WorldSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO world_baseline (id, world) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET world=excluded.world`,
      )
      .run(JSON.stringify(world));
  }
}

// ---------------------------------------------------------------------------
// Row <-> domain mapping (snake_case columns -> camelCase objects)
// ---------------------------------------------------------------------------

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  prompt: string;
  branch: string | null;
  origin_ref: string | null;
  status: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}
interface AgentRow {
  id: string;
  task_id: string;
  status: string;
  cwd: string;
  pid: number | null;
  waiting_reason: string | null;
  started_at: string;
  ended_at: string | null;
}
interface EscalationRow {
  id: string;
  type: string;
  status: string;
  prompt: string;
  context: string;
  agent_id: string | null;
  task_id: string | null;
  response: string | null;
  created_at: string;
  answered_at: string | null;
}
interface DecisionRow {
  id: string;
  cycle_id: string;
  action: string;
  outcome: string;
  detail: string;
  created_at: string;
}
interface WorldEventRow {
  id: string;
  kind: string;
  ref: string | null;
  summary: string;
  created_at: string;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    kind: r.kind as Task['kind'],
    title: r.title,
    prompt: r.prompt,
    branch: r.branch,
    originRef: r.origin_ref,
    status: r.status as Task['status'],
    agentId: r.agent_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToAgent(r: AgentRow): Agent {
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status as Agent['status'],
    cwd: r.cwd,
    pid: r.pid,
    waitingReason: r.waiting_reason,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}
function rowToEscalation(r: EscalationRow): Escalation {
  return {
    id: r.id,
    type: r.type as Escalation['type'],
    status: r.status as Escalation['status'],
    prompt: r.prompt,
    context: JSON.parse(r.context) as Record<string, unknown>,
    agentId: r.agent_id,
    taskId: r.task_id,
    response: r.response,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}
function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    cycleId: r.cycle_id,
    action: JSON.parse(r.action) as Decision['action'],
    outcome: r.outcome as Decision['outcome'],
    detail: r.detail,
    createdAt: r.created_at,
  };
}
function rowToWorldEvent(r: WorldEventRow): WorldEvent {
  return {
    id: r.id,
    kind: r.kind as WorldEvent['kind'],
    ref: r.ref,
    summary: r.summary,
    createdAt: r.created_at,
  };
}
