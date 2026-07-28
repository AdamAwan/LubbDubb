import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nanoid } from 'nanoid';
import { SCHEMA } from './schema.js';
import { liveParts } from '../plans/parts.js';
import type {
  Agent,
  AgentFile,
  AgentFileInput,
  AgentFlag,
  AgentFlagInput,
  AgentUsage,
  ConclusionAuthor,
  Decision,
  ErrorLogEntry,
  ErrorLogInput,
  Escalation,
  EscalationContext,
  Finding,
  FindingInput,
  FindingKind,
  FindingStatus,
  IssueConclusion,
  IssueDelivery,
  DeliveryAuthor,
  IssueConclusionVerdict,
  Job,
  Plan,
  PlanPart,
  PlanPartInput,
  PlanStatus,
  PriorityOverride,
  Proposal,
  Task,
  WorkNode,
  WorkNodeKind,
  WorkNodeObservation,
  WorkNodeProvenance,
  WorkItemFiling,
  WorkItemFilingStatus,
  WorldEvent,
  WorldEventInput,
  WorldSnapshot,
} from '../types.js';

/** Injectable clock so tests are deterministic. */
type Clock = () => string;
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
    this.migrate();
    this.now = clock;
  }

  /**
   * Additive, idempotent migrations for columns introduced after a table's
   * original `CREATE`. `CREATE TABLE IF NOT EXISTS` never alters an existing
   * table, so a column added to the schema is invisible on databases created by
   * an older build until we `ADD COLUMN` it here. Safe to run on every boot.
   */
  private migrate(): void {
    this.ensureColumns('tasks', {
      origin_title: 'TEXT',
      origin_summary: 'TEXT',
      dispatch_reason: 'TEXT',
    });
    this.ensureColumns('agents', {
      session_id: 'TEXT',
      cost_usd: 'REAL',
      input_tokens: 'INTEGER',
      output_tokens: 'INTEGER',
      num_turns: 'INTEGER',
      note: 'TEXT',
      noted_at: 'TEXT',
      resumed_at: 'TEXT',
    });
    this.ensureColumns('decisions', {
      rule: 'TEXT',
    });
    this.ensureColumns('findings', {
      ticket_ref: 'TEXT',
    });
  }

  private ensureColumns(table: string, columns: Record<string, string>): void {
    const existing = new Set(
      (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(columns)) {
      if (!existing.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  close(): void {
    // Persist anything still buffered before the handle goes away.
    for (const agentId of [...this.transcriptBuffers.keys()]) this.flushTranscript(agentId);
    this.db.close();
  }

  // -- Tasks ---------------------------------------------------------------

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
      originTitle: input.originTitle ?? null,
      originSummary: input.originSummary ?? null,
      dispatchReason: input.dispatchReason ?? null,
    };
    this.db
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

  /**
   * Is there already an active (queued/running/waiting) task on this branch?
   *
   * The mirror of {@link findActiveTaskByOrigin}, and the enforcement half of the
   * origin↔branch 1:1 property (issue #116). For every world-driven rule the two
   * are the same question, so this never fires for one; rule 0's operator-supplied
   * branch is the one dispatch path where they can diverge, and
   * `WorktreeManager.ensure` is reuse-first — so without this, two live agents
   * share one worktree directory with no merge anywhere to reconcile them.
   */
  findActiveTaskByBranch(branch: string): Task | null {
    const row = this.db
      .prepare(`SELECT * FROM tasks WHERE branch=? AND status IN ('queued','running','waiting') LIMIT 1`)
      .get(branch) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  // -- Jobs (operator-launched queue) --------------------------------------

  /** Queue a new operator-launched job. Starts `queued`; the dispatcher drains it. */
  createJob(input: { title: string; prompt: string; kind: Job['kind']; branch?: string | null }): Job {
    const ts = this.now();
    const job: Job = {
      id: `job_${nanoid(10)}`,
      title: input.title,
      prompt: input.prompt,
      kind: input.kind,
      branch: input.branch ?? null,
      status: 'queued',
      taskId: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, title, prompt, kind, branch, status, task_id, created_at, updated_at)
         VALUES (@id, @title, @prompt, @kind, @branch, @status, @taskId, @createdAt, @updatedAt)`,
      )
      .run(job);
    return job;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id=?`).get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  listJobs(limit = 100): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as JobRow[];
    return rows.map(rowToJob);
  }

  /** Jobs still awaiting a slot, oldest first — the order the dispatcher drains them. */
  listQueuedJobs(): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC`).all() as JobRow[];
    return rows.map(rowToJob);
  }

  /** Mark a job dispatched, linking the task it became, so it leaves the queue. */
  markJobDispatched(id: string, taskId: string): void {
    const existing = this.getJob(id);
    if (!existing) throw new Error(`Job ${id} not found`);
    this.db
      .prepare(`UPDATE jobs SET status='dispatched', task_id=?, updated_at=? WHERE id=?`)
      .run(taskId, this.now(), id);
  }

  /** Drop a still-queued job. Returns the job if it was cancellable, else null. */
  cancelJob(id: string): Job | null {
    const existing = this.getJob(id);
    if (!existing || existing.status !== 'queued') return null;
    const updatedAt = this.now();
    this.db.prepare(`UPDATE jobs SET status='cancelled', updated_at=? WHERE id=?`).run(updatedAt, id);
    return { ...existing, status: 'cancelled', updatedAt };
  }

  // -- Priority overrides (operator "Up next" re-ordering, issue #128) -------

  /**
   * Replace the operator's whole "Up next" priority order with `origins`, ranked
   * `0..n-1` in the given order (`0` = "do this next"). Replace-all is the point:
   * an origin the operator drops from the list has its override cleared, and an
   * empty list clears every override. Idempotent, and cheap — the set is tiny.
   */
  setPriorityOverrides(origins: string[]): void {
    const ts = this.now();
    const tx = this.db.transaction((rows: string[]) => {
      this.db.prepare(`DELETE FROM priority_overrides`).run();
      const insert = this.db.prepare(
        `INSERT INTO priority_overrides (origin, rank, updated_at, last_seen_at) VALUES (?, ?, ?, ?)`,
      );
      rows.forEach((origin, rank) => insert.run(origin, rank, ts, ts));
    });
    tx(origins);
  }

  /** The current overrides, lowest rank (highest priority) first. */
  listPriorityOverrides(): PriorityOverride[] {
    const rows = this.db
      .prepare(`SELECT origin, rank FROM priority_overrides ORDER BY rank ASC`)
      .all() as PriorityOverride[];
    return rows.map((r) => ({ origin: r.origin, rank: r.rank }));
  }

  /**
   * Keep the override set from lingering forever (issue #128): bump `last_seen_at`
   * for every origin the harness still tracks this pulse, then drop any override
   * whose origin has been untracked for longer than `ttlMs`. `ttlMs <= 0` disables
   * pruning entirely (a supported configuration). Called once per pulse.
   */
  reconcilePriorityOverrides(trackedOrigins: readonly string[], ttlMs: number): void {
    const now = this.now();
    const tx = this.db.transaction(() => {
      if (trackedOrigins.length > 0) {
        const placeholders = trackedOrigins.map(() => '?').join(',');
        this.db
          .prepare(`UPDATE priority_overrides SET last_seen_at=? WHERE origin IN (${placeholders})`)
          .run(now, ...trackedOrigins);
      }
      if (ttlMs > 0) {
        const cutoff = new Date(Date.parse(now) - ttlMs).toISOString();
        this.db.prepare(`DELETE FROM priority_overrides WHERE last_seen_at < ?`).run(cutoff);
      }
    });
    tx();
  }

  // -- Findings (what an agent noticed outside its own task) ----------------

  /**
   * File a finding for an agent. `agentId`/`taskId`/`originRef` are the caller's
   * own, resolved from its credential by the tool layer — there is no argument
   * for them, so a finding cannot be filed as another agent.
   *
   * An identical repeat (same agent, kind, ref and summary) refreshes the
   * existing row instead of inserting: an agent that reports the same thing on
   * every turn should not fill the operator's list. The status is deliberately
   * *not* reset — a dismissed finding repeated verbatim stays dismissed, which is
   * what dismissing it meant.
   */
  recordFinding(
    agentId: string,
    taskId: string,
    originRef: string | null,
    input: FindingInput,
  ): { finding: Finding; created: boolean } {
    const ts = this.now();
    // `IS` rather than `=` so a null ref matches a null ref (SQL equality doesn't).
    const existing = this.db
      .prepare(`SELECT * FROM findings WHERE agent_id=? AND kind=? AND ref IS ? AND summary=?`)
      .get(agentId, input.kind, input.ref, input.summary) as FindingRow | undefined;
    if (existing) {
      this.db.prepare(`UPDATE findings SET updated_at=? WHERE id=?`).run(ts, existing.id);
      return { finding: { ...rowToFinding(existing), updatedAt: ts }, created: false };
    }
    const finding: Finding = {
      id: `find_${nanoid(10)}`,
      agentId,
      taskId,
      originRef,
      kind: input.kind,
      ref: input.ref,
      summary: input.summary,
      status: 'open',
      jobId: null,
      ticketRef: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO findings (id, agent_id, task_id, origin_ref, kind, ref, summary, status, job_id, ticket_ref, created_at, updated_at)
         VALUES (@id, @agentId, @taskId, @originRef, @kind, @ref, @summary, @status, @jobId, @ticketRef, @createdAt, @updatedAt)`,
      )
      .run(finding);
    return { finding, created: true };
  }

  getFinding(id: string): Finding | null {
    const row = this.db.prepare(`SELECT * FROM findings WHERE id=?`).get(id) as FindingRow | undefined;
    return row ? rowToFinding(row) : null;
  }

  /** Every finding, newest first — the snapshot feed. */
  listFindings(limit = 100): Finding[] {
    const rows = this.db
      .prepare(`SELECT * FROM findings ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as FindingRow[];
    return rows.map(rowToFinding);
  }

  /**
   * Resolve an open finding: `promoted` or `filing` (with the job it became), or
   * `dismissed`. Only an open finding can be resolved, so a double-click can't
   * queue a second job for one finding. Returns null when there was nothing open
   * to resolve.
   */
  resolveFinding(
    id: string,
    status: Exclude<FindingStatus, 'open' | 'filed'>,
    jobId: string | null = null,
  ): Finding | null {
    const existing = this.getFinding(id);
    if (!existing || existing.status !== 'open') return null;
    const updatedAt = this.now();
    this.db
      .prepare(`UPDATE findings SET status=?, job_id=?, updated_at=? WHERE id=?`)
      .run(status, jobId, updatedAt, id);
    return { ...existing, status, jobId, updatedAt };
  }

  /** The finding a job was created for, if it was created for one. */
  findFindingByJobId(jobId: string): Finding | null {
    const row = this.db.prepare(`SELECT * FROM findings WHERE job_id=?`).get(jobId) as FindingRow | undefined;
    return row ? rowToFinding(row) : null;
  }

  /**
   * Record the ticket a filing agent created: `filing` → `filed`.
   *
   * Guarded in the write (`WHERE id=? AND status='filing'`) rather than by a
   * read-then-check, the same discipline `decideProposal` uses — an agent that
   * calls `link_ticket` twice links once, with no caller obliged to remember to
   * look first. Returns null when there was no filing finding to settle, which
   * is what the tool turns into an error the agent can read.
   */
  linkFindingTicket(id: string, ticketRef: string): Finding | null {
    const updatedAt = this.now();
    const result = this.db
      .prepare(`UPDATE findings SET status='filed', ticket_ref=?, updated_at=? WHERE id=? AND status='filing'`)
      .run(ticketRef, updatedAt, id);
    if (result.changes === 0) return null;
    return this.getFinding(id);
  }

  // -- Plans (the multi-PR issue funnel) -----------------------------------

  /**
   * Write (or refresh) an issue's plan, keyed by its `issue:<n>` origin. Upsert
   * rather than insert: a replan amends the verdict in place, keeping the plan id
   * its parts hang off. `createdAt` survives a refresh; `updatedAt` moves.
   */
  upsertPlan(input: {
    originRef: string;
    title: string;
    status: PlanStatus;
    reason?: string | null;
    statusCommentRef?: string | null;
  }): Plan {
    const existing = this.getPlanByOrigin(input.originRef);
    const ts = this.now();
    const plan: Plan = {
      id: existing?.id ?? `plan_${nanoid(10)}`,
      originRef: input.originRef,
      title: input.title,
      status: input.status,
      reason: input.reason ?? null,
      // Preserve a comment ref an earlier write established unless one is given —
      // the plan's status comment is edited in place, so losing the id orphans it.
      statusCommentRef: input.statusCommentRef ?? existing?.statusCommentRef ?? null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.db
      .prepare(
        `INSERT INTO plans (id, origin_ref, title, status, reason, status_comment_ref, created_at, updated_at)
         VALUES (@id, @originRef, @title, @status, @reason, @statusCommentRef, @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET title=excluded.title, status=excluded.status,
           reason=excluded.reason, status_comment_ref=excluded.status_comment_ref, updated_at=excluded.updated_at`,
      )
      .run(plan);
    return plan;
  }

  getPlan(id: string): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  getPlanByOrigin(originRef: string): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE origin_ref=?`).get(originRef) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listPlans(): Plan[] {
    const rows = this.db.prepare(`SELECT * FROM plans ORDER BY created_at ASC`).all() as PlanRow[];
    return rows.map(rowToPlan);
  }

  /**
   * Record who says an issue is finished, replacing any standing verdict for it.
   *
   * Latest-wins per issue rather than append-and-fold: a second pickup's agent
   * supersedes the first's, and an operator's toggle supersedes both. `createdAt`
   * is preserved across an overwrite so the row still dates the first time anyone
   * concluded this issue, which is what the cockpit shows when a verdict has been
   * revised.
   */
  recordIssueConclusion(input: {
    originRef: string;
    verdict: IssueConclusionVerdict;
    note: string;
    by: ConclusionAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueConclusion {
    const ts = this.now();
    const prev = this.getIssueConclusion(input.originRef);
    const row: IssueConclusion = {
      originRef: input.originRef,
      verdict: input.verdict,
      note: input.note,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      createdAt: prev?.createdAt ?? ts,
      updatedAt: ts,
    };
    const write = this.db.transaction((c: IssueConclusion) => {
      this.db
        .prepare(
          `INSERT INTO issue_conclusions (origin_ref, verdict, note, by, agent_id, task_id, created_at, updated_at)
           VALUES (@originRef, @verdict, @note, @by, @agentId, @taskId, @createdAt, @updatedAt)
           ON CONFLICT(origin_ref) DO UPDATE SET
             verdict=excluded.verdict, note=excluded.note, by=excluded.by,
             agent_id=excluded.agent_id, task_id=excluded.task_id, updated_at=excluded.updated_at`,
        )
        .run(c);
      // The other half of "an issue never carries both". See `recordDelivery`.
      this.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(c.originRef);
    });
    write(row);
    return row;
  }

  getIssueConclusion(originRef: string): IssueConclusion | null {
    const row = this.db.prepare(`SELECT * FROM issue_conclusions WHERE origin_ref=?`).get(originRef) as
      | IssueConclusionRow
      | undefined;
    return row ? rowToIssueConclusion(row) : null;
  }

  listIssueConclusions(): IssueConclusion[] {
    const rows = this.db.prepare(`SELECT * FROM issue_conclusions`).all() as IssueConclusionRow[];
    return rows.map(rowToIssueConclusion);
  }

  /**
   * Drop an issue's standing verdict, returning it to whatever its plan derives —
   * or to `undeclared`. The operator's "actually, nobody has decided this": a
   * delete rather than a third stored verdict, because `undeclared` is precisely
   * the absence of a row and storing it would give the resolver two ways to
   * express one state.
   */
  clearIssueConclusion(originRef: string): boolean {
    return this.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  /**
   * Record that an issue is delivered — the assessor's verdict, or the operator's.
   *
   * `decided_at` is preserved across an overwrite, so the row still dates the
   * moment the issue was *first* judged delivered. That is not cosmetic here the
   * way `created_at` is on a conclusion: it is the instant `deliveryHold` measures
   * world signal against, and refreshing it on every re-assessment would keep
   * moving the goalposts a transition has to clear.
   *
   * **Writing this clears any standing conclusion**, in the same transaction. The
   * assessor is later and better informed than the agent that declared its own
   * run, and leaving both would have rule 3b return the item to pickup while this
   * gate blocked it. The mirror lives in {@link recordIssueConclusion}; both are
   * here because this is the only file that touches SQLite, and a caller that
   * remembered one and forgot the other would leave the two contradicting.
   */
  recordDelivery(input: {
    originRef: string;
    summary: string;
    by: DeliveryAuthor;
    agentId?: string | null;
    taskId?: string | null;
  }): IssueDelivery {
    const ts = this.now();
    const prev = this.getDelivery(input.originRef);
    const row: IssueDelivery = {
      originRef: input.originRef,
      summary: input.summary,
      by: input.by,
      agentId: input.agentId ?? null,
      taskId: input.taskId ?? null,
      decidedAt: prev?.decidedAt ?? ts,
      updatedAt: ts,
    };
    const write = this.db.transaction((d: IssueDelivery) => {
      this.db
        .prepare(
          `INSERT INTO issue_deliveries (origin_ref, summary, by, agent_id, task_id, decided_at, updated_at)
           VALUES (@originRef, @summary, @by, @agentId, @taskId, @decidedAt, @updatedAt)
           ON CONFLICT(origin_ref) DO UPDATE SET
             summary=excluded.summary, by=excluded.by, agent_id=excluded.agent_id,
             task_id=excluded.task_id, updated_at=excluded.updated_at`,
        )
        .run(d);
      this.db.prepare(`DELETE FROM issue_conclusions WHERE origin_ref=?`).run(d.originRef);
    });
    write(row);
    return row;
  }

  getDelivery(originRef: string): IssueDelivery | null {
    const row = this.db.prepare(`SELECT * FROM issue_deliveries WHERE origin_ref=?`).get(originRef) as
      | IssueDeliveryRow
      | undefined;
    return row ? rowToDelivery(row) : null;
  }

  /**
   * Every standing delivery verdict.
   *
   * **Unbounded on purpose**, exactly as `listProposals` is: a verdict that aged
   * out of a window would silently re-open pickup on work already delivered, which
   * is the failure this table exists to prevent. It stays small — one row per
   * assessed issue — and what bounds the *event* read it feeds is time and item
   * (`deliverySignalQuery`), never a row count.
   */
  listDeliveries(): IssueDelivery[] {
    const rows = this.db.prepare(`SELECT * FROM issue_deliveries`).all() as IssueDeliveryRow[];
    return rows.map(rowToDelivery);
  }

  /**
   * Drop an issue's delivery verdict — the operator's "no, there is more here".
   *
   * A delete rather than a stored `not_delivered`, for {@link clearIssueConclusion}'s
   * reason: the absence of a verdict is precisely one state, and storing it would
   * give the gate two ways to express it.
   */
  clearDelivery(originRef: string): boolean {
    return this.db.prepare(`DELETE FROM issue_deliveries WHERE origin_ref=?`).run(originRef).changes > 0;
  }

  /**
   * Fold a plan's declared parts onto its rows, **merging on slug**: an existing
   * part keeps its branch, PR, status and task (it may already be in flight) and
   * only its declaration — seq/title/scope/dependsOn — is refreshed. Parts absent
   * from the amended plan are left alone rather than deleted; retiring one is a
   * status transition, not a disappearance.
   */
  upsertPlanParts(planId: string, parts: PlanPartInput[]): PlanPart[] {
    const ts = this.now();
    const existing = new Map(this.listPlanParts(planId).map((p) => [p.slug, p]));
    const rows = parts.map((input) => {
      const prev = existing.get(input.slug);
      const part: PlanPart = {
        id: `${planId}:${input.slug}`,
        planId,
        slug: input.slug,
        seq: input.seq,
        title: input.title,
        scope: input.scope,
        dependsOn: input.dependsOn,
        branch: prev?.branch ?? null,
        prNumber: prev?.prNumber ?? null,
        status: prev?.status ?? 'pending',
        taskId: prev?.taskId ?? null,
        createdAt: prev?.createdAt ?? ts,
        updatedAt: ts,
      };
      return part;
    });
    const stmt = this.db.prepare(
      `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, depends_on, branch, pr_number, status, task_id, created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @scope, @dependsOn, @branch, @prNumber, @status, @taskId, @createdAt, @updatedAt)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, scope=excluded.scope,
         depends_on=excluded.depends_on, updated_at=excluded.updated_at`,
    );
    const insertAll = this.db.transaction((all: PlanPart[]) => {
      for (const p of all) stmt.run({ ...p, dependsOn: JSON.stringify(p.dependsOn) });
    });
    insertAll(rows);
    return rows;
  }

  listPlanParts(planId: string): PlanPart[] {
    const rows = this.db
      .prepare(`SELECT * FROM plan_parts WHERE plan_id=? ORDER BY seq ASC, slug ASC`)
      .all(planId) as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

  /** Every part of every plan — what the dispatcher and the reconciler both walk. */
  listAllPlanParts(): PlanPart[] {
    const rows = this.db.prepare(`SELECT * FROM plan_parts ORDER BY plan_id ASC, seq ASC`).all() as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

  /**
   * Move a part's *progress* — status, branch, PR, task — leaving its declaration
   * (seq/title/scope/dependsOn) to {@link upsertPlanParts}. The two halves of a part
   * row have different authors: the planner declares, the scheduler and the
   * reconciler record what happened. Returns null when the part is gone.
   */
  updatePlanPart(
    id: string,
    patch: { status?: PlanPart['status']; branch?: string | null; prNumber?: number | null; taskId?: string | null },
  ): PlanPart | null {
    const row = this.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const next: PlanPart = {
      ...rowToPlanPart(row),
      ...patch,
      updatedAt: this.now(),
    };
    this.db
      .prepare(
        `UPDATE plan_parts SET status=@status, branch=@branch, pr_number=@prNumber, task_id=@taskId, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        branch: next.branch,
        prNumber: next.prNumber,
        taskId: next.taskId,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  /**
   * A part's agent actually spawned. Called from the executor *after* the spawn, for
   * the same reason {@link markJobDispatched} is: a dispatch the cap/pause gate holds
   * must leave the part `ready` for a later cycle, not claim it started.
   */
  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.updatePlanPart(id, { status: 'dispatched', taskId, branch });
  }

  /** Move a plan's own status (the parts roll-up, a replan, an abandon). */
  setPlanStatus(id: string, status: PlanStatus): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.now();
    this.db.prepare(`UPDATE plans SET status=?, updated_at=? WHERE id=?`).run(status, updatedAt, id);
    return { ...rowToPlan(row), status, updatedAt };
  }

  /** Remember the provider comment id so the plan's status comment is edited, never re-posted. */
  setPlanStatusComment(id: string, ref: string): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.now();
    this.db.prepare(`UPDATE plans SET status_comment_ref=?, updated_at=? WHERE id=?`).run(ref, updatedAt, id);
    return { ...rowToPlan(row), statusCommentRef: ref, updatedAt };
  }

  /**
   * Fold a plan's part statuses back onto the plan: every part merged => `complete`,
   * anything outstanding after that => back to `active` (a replan can add work to a
   * finished plan). Returns the plan **only when the roll-up moved it**, so a caller
   * can treat the return as the "the plan just completed" edge rather than re-deriving
   * it. A partless plan (`single`, or one still `planning`) is never touched, and a
   * retired part is not outstanding work — an amended plan that dropped its last
   * unstarted part is complete, not stuck.
   */
  rollUpPlanStatus(planId: string): Plan | null {
    const row = this.db.prepare(`SELECT * FROM plans WHERE id=?`).get(planId) as PlanRow | undefined;
    if (!row) return null;
    const plan = rowToPlan(row);
    if (plan.status !== 'active' && plan.status !== 'complete') return null;
    const parts = liveParts(this.listPlanParts(planId));
    if (parts.length === 0) return null;
    const next: PlanStatus = parts.every((p) => p.status === 'merged') ? 'complete' : 'active';
    if (next === plan.status) return null;
    return this.setPlanStatus(planId, next);
  }

  // -- Agents --------------------------------------------------------------

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
      startedAt: this.now(),
      endedAt: null,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      numTurns: null,
      note: null,
      notedAt: null,
      resumedAt: null,
    };
    this.db
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
    this.db
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
    this.db.prepare(`UPDATE agents SET resumed_at=? WHERE id=?`).run(at, id);
  }

  getAgent(id: string): Agent | null {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id=?`).get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  listAgents(): Agent[] {
    const rows = this.db.prepare(`SELECT * FROM agents ORDER BY started_at DESC`).all() as AgentRow[];
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
    this.db
      .prepare(
        `UPDATE agents SET cost_usd=@costUsd, input_tokens=@inputTokens, output_tokens=@outputTokens, num_turns=@numTurns WHERE id=@id`,
      )
      .run({ id, ...next });
    // Clamp: a cumulative total should never regress, but a restarted CLI would
    // reset it — never let that poison the window sum with a negative delta.
    const delta = Math.max(0, (usage.costUsd ?? 0) - (existing.costUsd ?? 0));
    if (delta > 0) {
      this.db.prepare(`INSERT INTO usage_events (agent_id, cost_usd, at) VALUES (?,?,?)`).run(id, delta, this.now());
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
   * call, and read straight off `listAgents()` with no new snapshot key.
   *
   * The note deliberately survives the agent: a finished agent's last note is the
   * best one-line summary of the run there is, and it costs nothing to keep.
   */
  recordAgentNote(id: string, note: string): string {
    const at = this.now();
    const changed = this.db.prepare(`UPDATE agents SET note=?, noted_at=? WHERE id=?`).run(note, at, id).changes;
    if (changed === 0) throw new Error(`Agent ${id} not found`);
    return at;
  }

  /** Total agent cost recorded since `sinceIso` — the rolling-window aggregate. */
  sumUsageCostSince(sinceIso: string): number {
    const row = this.db
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
    const existing = this.db
      .prepare(`SELECT id FROM agent_flags WHERE agent_id=? AND ref=?`)
      .get(agentId, input.ref) as { id: string } | undefined;
    const flag: AgentFlag = {
      id: existing?.id ?? `flag_${nanoid(10)}`,
      agentId,
      kind: input.kind,
      label: input.label,
      ref: input.ref,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_flags (id, agent_id, kind, label, ref, created_at)
         VALUES (@id, @agentId, @kind, @label, @ref, @createdAt)
         ON CONFLICT(agent_id, ref) DO UPDATE SET kind=excluded.kind, label=excluded.label, created_at=excluded.created_at`,
      )
      .run(flag);
    return flag;
  }

  getFlag(id: string): AgentFlag | null {
    const row = this.db.prepare(`SELECT * FROM agent_flags WHERE id=?`).get(id) as AgentFlagRow | undefined;
    return row ? rowToFlag(row) : null;
  }

  listFlags(agentId: string): AgentFlag[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_flags WHERE agent_id=? ORDER BY created_at ASC`)
      .all(agentId) as AgentFlagRow[];
    return rows.map(rowToFlag);
  }

  /** Every flag across all agents, newest first — the snapshot feed. */
  listAllFlags(): AgentFlag[] {
    const rows = this.db
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
    const existing = this.db
      .prepare(`SELECT id FROM agent_files WHERE agent_id=? AND path=?`)
      .get(agentId, input.path) as { id: string } | undefined;
    const file: AgentFile = {
      id: existing?.id ?? `file_${nanoid(10)}`,
      agentId,
      path: input.path,
      tool: input.tool,
      promoted: input.promoted,
      createdAt: this.now(),
    };
    this.db
      .prepare(
        `INSERT INTO agent_files (id, agent_id, path, tool, promoted, created_at)
         VALUES (@id, @agentId, @path, @tool, @promoted, @createdAt)
         ON CONFLICT(agent_id, path) DO UPDATE SET tool=excluded.tool, promoted=excluded.promoted, created_at=excluded.created_at`,
      )
      .run({ ...file, promoted: file.promoted ? 1 : 0 });
    return file;
  }

  listFiles(agentId: string): AgentFile[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_files WHERE agent_id=? ORDER BY created_at ASC`)
      .all(agentId) as AgentFileRow[];
    return rows.map(rowToFile);
  }

  /** Every recorded file across all agents, newest first — the snapshot feed. */
  listAllFiles(): AgentFile[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_files ORDER BY created_at DESC, rowid DESC`)
      .all() as AgentFileRow[];
    return rows.map(rowToFile);
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

  /**
   * Flip an escalation to `dismissed`, persisting the caller-built context (which
   * carries the dismissal reason + timestamp). The store stays a dumb data layer:
   * the decision of *what* to dismiss and *why* lives in the EscalationInbox.
   */
  dismissEscalation(id: string, context: Record<string, unknown>): Escalation {
    const existing = this.getEscalation(id);
    if (!existing) throw new Error(`Escalation ${id} not found`);
    this.db.prepare(`UPDATE escalations SET status='dismissed', context=? WHERE id=?`).run(JSON.stringify(context), id);
    return { ...existing, status: 'dismissed', context };
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

  // -- Proposals (human decisions) -----------------------------------------

  createProposal(input: Omit<Proposal, 'id' | 'status' | 'note' | 'decidedBy' | 'decidedAt' | 'createdAt'>): Proposal {
    const proposal: Proposal = {
      id: `prop_${nanoid(10)}`,
      status: 'pending',
      note: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: this.now(),
      kind: input.kind,
      ref: input.ref,
      action: input.action,
      escalationId: input.escalationId,
    };
    this.db
      .prepare(
        `INSERT INTO proposals (id, kind, ref, status, action, note, decided_by, decided_at, escalation_id, created_at)
         VALUES (@id, @kind, @ref, @status, @action, @note, @decidedBy, @decidedAt, @escalationId, @createdAt)`,
      )
      .run({ ...proposal, action: JSON.stringify(proposal.action) });
    return proposal;
  }

  /**
   * Settle a pending proposal, once. The `status='pending'` predicate makes this a
   * compare-and-set rather than a read-then-write: a second accept changes no rows
   * and gets `null` back, so "accepting twice posts once" is a property of the
   * write, not of whoever remembered to check first.
   */
  decideProposal(
    id: string,
    status: Extract<Proposal['status'], 'accepted' | 'rejected'>,
    note: string | null,
    decidedBy: NonNullable<Proposal['decidedBy']>,
  ): Proposal | null {
    const decidedAt = this.now();
    const res = this.db
      .prepare(`UPDATE proposals SET status=?, note=?, decided_by=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(status, note, decidedBy, decidedAt, id);
    if (res.changes === 0) return null;
    const existing = this.getProposal(id);
    return existing;
  }

  getProposal(id: string): Proposal | null {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id=?`).get(id) as ProposalRow | undefined;
    return row ? rowToProposal(row) : null;
  }

  /**
   * Every proposal, newest first — deliberately unbounded. The dispatcher's gate
   * reads the *standing* verdict for a ref, so a rejection that aged out of a
   * window would quietly re-propose an act the operator already refused.
   */
  listProposals(): Proposal[] {
    const rows = this.db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC, rowid DESC`).all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  // -- Decisions (audit) ---------------------------------------------------

  recordDecision(input: Omit<Decision, 'id' | 'createdAt' | 'rule'>): Decision {
    // The rule id rides on the action (its transport from the dispatcher); lift
    // it into its own column here so it's first-class on the decision row.
    const decision: Decision = {
      id: `dec_${nanoid(10)}`,
      createdAt: this.now(),
      rule: input.action.rule ?? null,
      ...input,
    };
    this.db
      .prepare(`INSERT INTO decisions (id, cycle_id, action, outcome, detail, rule, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(
        decision.id,
        decision.cycleId,
        JSON.stringify(decision.action),
        decision.outcome,
        decision.detail,
        decision.rule,
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

  // -- Error log -----------------------------------------------------------

  recordError(input: ErrorLogInput): ErrorLogEntry {
    const entry: ErrorLogEntry = {
      id: `err_${nanoid(10)}`,
      createdAt: this.now(),
      source: input.source,
      message: input.message,
      detail: input.detail ?? null,
    };
    this.db
      .prepare(`INSERT INTO error_events (id, source, message, detail, created_at) VALUES (?,?,?,?,?)`)
      .run(entry.id, entry.source, entry.message, entry.detail, entry.createdAt);
    return entry;
  }

  listErrors(limit = 100): ErrorLogEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM error_events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as ErrorEventRow[];
    return rows.map(rowToErrorEntry);
  }

  /**
   * Drop the whole error log, returning how many rows went.
   *
   * A delete rather than an acknowledged-up-to watermark: the log is a list an
   * operator reads and clears, not a record anything decides on — nothing in the
   * harness reads `error_events` back, so a row nobody has read is the only thing
   * it can lose. All of it, never a slice: "clear the faults I can see" is a
   * different sentence on a list the server truncates at 100, and the second
   * cockpit watching would disagree with the first about which those were.
   */
  clearErrors(): number {
    return this.db.prepare(`DELETE FROM error_events`).run().changes;
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

  /**
   * Transitions observed for `refs` strictly after `since` — "has anything
   * happened to these items since then", which is what ends a rejection's
   * standing (issue #109 phase 4, `rejectionSignalQuery`).
   *
   * Bounded by time and item rather than by row count, unlike {@link
   * listWorldEvents}, whose limit serves a feed that only has to be long enough
   * to read. A rejection is unbounded in age, so a count-bounded read would judge
   * an old one against events it cannot see; naming the window removes the case
   * instead of answering it, and keeps the read small — it is the handful of
   * items actually carrying a rejection, over the `world_events(created_at)`
   * index. No refs, no query.
   */
  listWorldEventsSince(since: string, refs: string[]): WorldEvent[] {
    if (refs.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM world_events WHERE created_at > ? AND ref IN (${refs.map(() => '?').join(',')})
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(since, ...refs) as WorldEventRow[];
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

  /**
   * Write this pulse's observations. Upsert-only: a node not in `observations` is
   * left exactly as it was, which is what makes the graph outlive the world's
   * memory of a merged PR.
   *
   * `parent_ref` is write-once once non-null — work lineage does not change, and an
   * immutable edge makes a cycle impossible rather than merely guarded, which
   * matters because {@link listWorkSubtree} is recursive. A null parent may still be
   * filled later, so a stray PR can be adopted when its issue link appears.
   */
  recordWorkGraph(observations: WorkNodeObservation[]): void {
    const ts = this.now();
    const stmt = this.db.prepare(`
      INSERT INTO work_nodes
        (ref, kind, parent_ref, base_ref, title, status, terminal, provenance, first_seen_at, last_seen_at)
      VALUES
        (@ref, @kind, @parentRef, @baseRef, @title, @status, @terminal, @provenance, @ts, @ts)
      ON CONFLICT(ref) DO UPDATE SET
        kind         = excluded.kind,
        parent_ref   = COALESCE(work_nodes.parent_ref, excluded.parent_ref),
        base_ref     = COALESCE(excluded.base_ref, work_nodes.base_ref),
        title        = excluded.title,
        status       = excluded.status,
        terminal     = excluded.terminal,
        provenance   = excluded.provenance,
        last_seen_at = excluded.last_seen_at
    `);
    const write = this.db.transaction((rows: WorkNodeObservation[]) => {
      for (const o of rows)
        stmt.run({
          ref: o.ref,
          kind: o.kind,
          parentRef: o.parentRef ?? null,
          baseRef: o.baseRef ?? null,
          title: o.title,
          status: o.status,
          terminal: o.terminal ? 1 : 0,
          provenance: o.provenance ?? null,
          ts,
        });
    });
    write(observations);
  }

  /** Every node with no parent — one per work item the harness has ever touched. */
  listWorkRoots(): WorkNode[] {
    const rows = this.db
      .prepare(`SELECT * FROM work_nodes WHERE parent_ref IS NULL ORDER BY last_seen_at DESC`)
      .all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  /**
   * One root and everything beneath it. `UNION` rather than `UNION ALL` so the walk
   * terminates even if a cycle ever reached the table — belt to the write-once
   * parent's braces.
   */
  listWorkSubtree(rootRef: string): WorkNode[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(ref) AS (
           SELECT ref FROM work_nodes WHERE ref = ?
           UNION
           SELECT n.ref FROM work_nodes n JOIN sub s ON n.parent_ref = s.ref
         )
         SELECT w.* FROM work_nodes w JOIN sub ON w.ref = sub.ref
         ORDER BY w.first_seen_at ASC, w.ref ASC`,
      )
      .all(rootRef) as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  /**
   * Every node, in one read.
   *
   * The unrecorded-work detector needs the whole table — its verdict is per-node
   * but the evidence beside it is what ran underneath — and rebuilding that from
   * {@link listWorkRoots} plus a {@link listWorkSubtree} each is N+1 queries for
   * something one `SELECT` answers.
   *
   * Note this is *not* wired into the recorder, which still reads `existing` the
   * roots-then-subtrees way. Doing so would close the stage-1 backfill reach gap
   * (a node whose ancestor chain is incomplete is invisible to the fold), and that
   * gap was ruled on and deliberately left — see `docs/spec/14-persistence.md`.
   */
  listWorkNodes(): WorkNode[] {
    const rows = this.db.prepare(`SELECT * FROM work_nodes ORDER BY first_seen_at ASC`).all() as WorkNodeRow[];
    return rows.map(rowToWorkNode);
  }

  // -- Work-item filings (stage 3) ------------------------------------------

  /**
   * Open a filing for an unrecorded node.
   *
   * Returns null when one already stands for that target: the refusal lives in
   * the write (`target_ref` is the primary key), not in a caller remembering to
   * look first — the same discipline as `decideProposal` and `linkFindingTicket`.
   */
  createWorkItemFiling(input: { targetRef: string; jobId: string }): WorkItemFiling | null {
    const ts = this.now();
    const row: WorkItemFiling = {
      targetRef: input.targetRef,
      jobId: input.jobId,
      status: 'filing',
      ticketRef: null,
      createdAt: ts,
      updatedAt: ts,
    };
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO work_item_filings (target_ref, job_id, status, ticket_ref, created_at, updated_at)
         VALUES (@targetRef, @jobId, @status, @ticketRef, @createdAt, @updatedAt)`,
      )
      .run(row);
    return result.changes === 0 ? null : row;
  }

  /**
   * Every filing ever opened.
   *
   * Unbounded on purpose, like `listProposals`: a linked filing is what parents
   * its node, and one that aged out of a window would have the fold quietly
   * un-record work the operator already filed.
   */
  listWorkItemFilings(): WorkItemFiling[] {
    const rows = this.db
      .prepare(`SELECT * FROM work_item_filings ORDER BY created_at ASC`)
      .all() as WorkItemFilingRow[];
    return rows.map(rowToWorkItemFiling);
  }

  /** The filing a job was created for, if it was created for one. */
  findWorkItemFilingByJobId(jobId: string): WorkItemFiling | null {
    const row = this.db.prepare(`SELECT * FROM work_item_filings WHERE job_id=?`).get(jobId) as
      | WorkItemFilingRow
      | undefined;
    return row ? rowToWorkItemFiling(row) : null;
  }

  /**
   * Record the ticket a filing agent created: `filing` → `filed`.
   *
   * Guarded in the write rather than by a read-then-check, mirroring
   * {@link linkFindingTicket} exactly — an agent that calls `link_ticket` twice
   * links once. Null means there was nothing awaiting a ticket, which the tool
   * turns into an error the agent can read.
   */
  linkWorkItemFiling(jobId: string, ticketRef: string): WorkItemFiling | null {
    const updatedAt = this.now();
    const result = this.db
      .prepare(
        `UPDATE work_item_filings SET status='filed', ticket_ref=?, updated_at=? WHERE job_id=? AND status='filing'`,
      )
      .run(ticketRef, updatedAt, jobId);
    if (result.changes === 0) return null;
    return this.findWorkItemFilingByJobId(jobId);
  }

  /**
   * The operator's other answer to unrecorded work: no ticket is wanted for this.
   *
   * Idempotent in the write (`target_ref` is the primary key), so a second click
   * is one row — the discipline `createWorkItemFiling` follows for the same
   * reason. Undone by {@link unignoreWorkItem}, which is a delete: an ignore that
   * could be "cleared" to some other state would be a second representation of
   * "not ignored".
   */
  ignoreWorkItem(targetRef: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO work_item_ignores (target_ref, created_at) VALUES (?, ?)`)
      .run(targetRef, this.now());
  }

  /** Undo. Silent when nothing stood — the caller asked for an absence and has it. */
  unignoreWorkItem(targetRef: string): void {
    this.db.prepare(`DELETE FROM work_item_ignores WHERE target_ref=?`).run(targetRef);
  }

  /**
   * Every standing ignore. Unbounded for `listWorkItemFilings`' reason: a verdict
   * that aged out of a window would put a row the operator dismissed back in front
   * of them, which is the whole thing they were clearing.
   */
  listWorkItemIgnores(): string[] {
    const rows = this.db.prepare(`SELECT target_ref FROM work_item_ignores`).all() as { target_ref: string }[];
    return rows.map((r) => r.target_ref);
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
  origin_title: string | null;
  origin_summary: string | null;
  dispatch_reason: string | null;
  status: string;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}
interface JobRow {
  id: string;
  title: string;
  prompt: string;
  kind: string;
  branch: string | null;
  status: string;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}
interface FindingRow {
  id: string;
  agent_id: string;
  task_id: string;
  origin_ref: string | null;
  kind: string;
  ref: string | null;
  summary: string;
  status: string;
  job_id: string | null;
  /** Nullable *and* possibly absent: added by `migrate()` on databases from an older build. */
  ticket_ref: string | null | undefined;
  created_at: string;
  updated_at: string;
}
interface PlanRow {
  id: string;
  origin_ref: string;
  title: string;
  status: string;
  reason: string | null;
  status_comment_ref: string | null;
  created_at: string;
  updated_at: string;
}
interface IssueConclusionRow {
  origin_ref: string;
  verdict: string;
  note: string;
  by: string;
  agent_id: string | null;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}
interface IssueDeliveryRow {
  origin_ref: string;
  summary: string;
  by: string;
  agent_id: string | null;
  task_id: string | null;
  decided_at: string;
  updated_at: string;
}
interface PlanPartRow {
  id: string;
  plan_id: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  depends_on: string;
  branch: string | null;
  pr_number: number | null;
  status: string;
  task_id: string | null;
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
interface ProposalRow {
  id: string;
  kind: string;
  ref: string;
  status: string;
  action: string;
  note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  escalation_id: string | null;
  created_at: string;
}
interface DecisionRow {
  id: string;
  cycle_id: string;
  action: string;
  outcome: string;
  detail: string;
  rule: string | null;
  created_at: string;
}
interface WorldEventRow {
  id: string;
  kind: string;
  ref: string | null;
  summary: string;
  created_at: string;
}
interface ErrorEventRow {
  id: string;
  source: string;
  message: string;
  detail: string | null;
  created_at: string;
}
interface WorkNodeRow {
  ref: string;
  kind: string;
  parent_ref: string | null;
  base_ref: string | null;
  title: string;
  status: string;
  terminal: number;
  provenance: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToWorkNode(row: WorkNodeRow): WorkNode {
  return {
    ref: row.ref,
    kind: row.kind as WorkNodeKind,
    parentRef: row.parent_ref,
    baseRef: row.base_ref,
    title: row.title,
    status: row.status,
    terminal: row.terminal === 1,
    provenance: row.provenance as WorkNodeProvenance | null,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

interface WorkItemFilingRow {
  target_ref: string;
  job_id: string;
  status: string;
  ticket_ref: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkItemFiling(row: WorkItemFilingRow): WorkItemFiling {
  return {
    targetRef: row.target_ref,
    jobId: row.job_id,
    status: row.status as WorkItemFilingStatus,
    ticketRef: row.ticket_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    kind: r.kind as Job['kind'],
    branch: r.branch,
    status: r.status as Job['status'],
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToFinding(r: FindingRow): Finding {
  return {
    id: r.id,
    agentId: r.agent_id,
    taskId: r.task_id,
    originRef: r.origin_ref,
    kind: r.kind as FindingKind,
    ref: r.ref,
    summary: r.summary,
    status: r.status as FindingStatus,
    jobId: r.job_id,
    ticketRef: r.ticket_ref ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    originRef: r.origin_ref,
    title: r.title,
    status: r.status as PlanStatus,
    reason: r.reason,
    statusCommentRef: r.status_comment_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToIssueConclusion(r: IssueConclusionRow): IssueConclusion {
  return {
    originRef: r.origin_ref,
    verdict: r.verdict as IssueConclusionVerdict,
    note: r.note,
    by: r.by as ConclusionAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function rowToDelivery(r: IssueDeliveryRow): IssueDelivery {
  return {
    originRef: r.origin_ref,
    summary: r.summary,
    by: r.by as DeliveryAuthor,
    agentId: r.agent_id,
    taskId: r.task_id,
    decidedAt: r.decided_at,
    updatedAt: r.updated_at,
  };
}
function rowToPlanPart(r: PlanPartRow): PlanPart {
  return {
    id: r.id,
    planId: r.plan_id,
    slug: r.slug,
    seq: r.seq,
    title: r.title,
    scope: r.scope,
    // Written as JSON by upsertPlanParts; a corrupt value degrades to "no deps"
    // rather than throwing the whole snapshot away.
    dependsOn: parseDependsOn(r.depends_on),
    branch: r.branch,
    prNumber: r.pr_number,
    status: r.status as PlanPart['status'],
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
function parseDependsOn(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
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
function rowToEscalation(r: EscalationRow): Escalation {
  return {
    id: r.id,
    type: r.type as Escalation['type'],
    status: r.status as Escalation['status'],
    prompt: r.prompt,
    context: JSON.parse(r.context) as EscalationContext,
    agentId: r.agent_id,
    taskId: r.task_id,
    response: r.response,
    createdAt: r.created_at,
    answeredAt: r.answered_at,
  };
}
function rowToProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    kind: r.kind as Proposal['kind'],
    ref: r.ref,
    status: r.status as Proposal['status'],
    action: JSON.parse(r.action) as Proposal['action'],
    note: r.note,
    decidedBy: r.decided_by as Proposal['decidedBy'],
    decidedAt: r.decided_at,
    escalationId: r.escalation_id,
    createdAt: r.created_at,
  };
}
function rowToDecision(r: DecisionRow): Decision {
  return {
    id: r.id,
    cycleId: r.cycle_id,
    action: JSON.parse(r.action) as Decision['action'],
    outcome: r.outcome as Decision['outcome'],
    detail: r.detail,
    rule: r.rule,
    createdAt: r.created_at,
  };
}
function rowToErrorEntry(r: ErrorEventRow): ErrorLogEntry {
  return {
    id: r.id,
    source: r.source as ErrorLogEntry['source'],
    message: r.message,
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
