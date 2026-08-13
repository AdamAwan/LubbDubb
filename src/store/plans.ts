import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { liveParts, partSettled } from '../plans/parts.js';
import type { PartOutcomeKind, Plan, PlanPart, PlanPartInput, PlanStatus } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

export const PLAN_COLUMNS: ColumnMigrations = {
  // `plans`/`plan_parts` were introduced as fresh `CREATE TABLE`s and needed no
  // entry here. Columns added to them *now* do: `CREATE TABLE IF NOT EXISTS`
  // never alters an existing table, so without these the fields are invisible
  // on every database that predates them.
  plans: {
    diagnosis: 'TEXT',
    approach: 'TEXT',
    risks: 'TEXT',
    out_of_scope: 'TEXT',
    document: 'TEXT',
    discussing: 'INTEGER NOT NULL DEFAULT 0',
  },
  plan_parts: {
    rationale: 'TEXT',
    acceptance: 'TEXT',
    expected_kind: 'TEXT',
    outcome_kind: 'TEXT',
    outcome_ref: 'TEXT',
    outcome_summary: 'TEXT',
    blocked_reason: 'TEXT',
  },
};

/**
 * The `plans` and `plan_parts` tables: the multi-PR issue funnel.
 *
 * One module rather than two because {@link PlanStore.rollUpPlanStatus} reads the
 * parts and writes the plan — a fold across a module boundary would buy nothing
 * and would put half of it out of reach.
 */
export class PlanStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write (or refresh) an issue's plan, keyed by its `issue:<n>` origin. Upsert
   * rather than insert: a replan amends the verdict in place, keeping the plan id
   * its parts hang off. `createdAt` survives a refresh; `updatedAt` moves.
   */
  upsertPlan(input: {
    originRef: string;
    title: string;
    status: PlanStatus;
    diagnosis?: string | null;
    approach?: string | null;
    reason?: string | null;
    risks?: string | null;
    outOfScope?: string | null;
    document?: string | null;
    statusCommentRef?: string | null;
  }): Plan {
    const existing = this.getPlanByOrigin(input.originRef);
    const ts = this.ctx.now();
    const plan: Plan = {
      id: existing?.id ?? `plan_${nanoid(10)}`,
      originRef: input.originRef,
      title: input.title,
      status: input.status,
      reason: input.reason ?? null,
      // Preserved on absence for the same reason `statusCommentRef` is: a caller
      // that writes a status without re-stating the narrative must not erase it.
      diagnosis: input.diagnosis ?? existing?.diagnosis ?? null,
      approach: input.approach ?? existing?.approach ?? null,
      risks: input.risks ?? existing?.risks ?? null,
      outOfScope: input.outOfScope ?? existing?.outOfScope ?? null,
      document: input.document ?? existing?.document ?? null,
      // Not settable here: discussion is its own one-way transition (`setPlanDiscussing`),
      // so an ingestion cannot accidentally re-open one it is meant to be closing.
      discussing: existing?.discussing ?? false,
      // Preserve a comment ref an earlier write established unless one is given —
      // the plan's status comment is edited in place, so losing the id orphans it.
      statusCommentRef: input.statusCommentRef ?? existing?.statusCommentRef ?? null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO plans (id, origin_ref, title, status, diagnosis, approach, reason, risks, out_of_scope, document, discussing, status_comment_ref, created_at, updated_at)
         VALUES (@id, @originRef, @title, @status, @diagnosis, @approach, @reason, @risks, @outOfScope, @document, @discussing, @statusCommentRef, @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET title=excluded.title, status=excluded.status,
           diagnosis=excluded.diagnosis, approach=excluded.approach,
           reason=excluded.reason, risks=excluded.risks, out_of_scope=excluded.out_of_scope,
           document=excluded.document, status_comment_ref=excluded.status_comment_ref, updated_at=excluded.updated_at`,
      )
      .run({ ...plan, discussing: plan.discussing ? 1 : 0 });
    return plan;
  }

  getPlan(id: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  getPlanByOrigin(originRef: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE origin_ref=?`).get(originRef) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listPlans(): Plan[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM plans ORDER BY created_at ASC`).all() as PlanRow[];
    return rows.map(rowToPlan);
  }

  /**
   * Fold a plan's declared parts onto its rows, **merging on slug**: an existing
   * part keeps its branch, PR, status and task (it may already be in flight) and
   * only its declaration — seq/title/scope/dependsOn — is refreshed. Parts absent
   * from the amended plan are left alone rather than deleted; retiring one is a
   * status transition, not a disappearance.
   */
  upsertPlanParts(planId: string, parts: PlanPartInput[]): PlanPart[] {
    const ts = this.ctx.now();
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
        rationale: input.rationale,
        acceptance: input.acceptance,
        expectedKind: input.expectedKind,
        // Progress, not declaration — an amendment re-declaring a part must not
        // wipe an outcome it already reached. Same split as branch/prNumber below.
        outcomeKind: prev?.outcomeKind ?? null,
        outcomeRef: prev?.outcomeRef ?? null,
        outcomeSummary: prev?.outcomeSummary ?? null,
        dependsOn: input.dependsOn,
        branch: prev?.branch ?? null,
        prNumber: prev?.prNumber ?? null,
        status: prev?.status ?? 'pending',
        // Progress like the outcome columns: it explains a status this call is not
        // allowed to change, so an amendment re-declaring a part leaves it alone.
        blockedReason: prev?.blockedReason ?? null,
        taskId: prev?.taskId ?? null,
        createdAt: prev?.createdAt ?? ts,
        updatedAt: ts,
      };
      return part;
    });
    const stmt = this.ctx.db.prepare(
      // The outcome columns are deliberately absent from DO UPDATE SET: they are
      // progress, and an amendment re-declaring a part must leave what it produced
      // alone. `expected_kind` is part of the declaration, so it does update.
      `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, rationale, acceptance, expected_kind,
         outcome_kind, outcome_ref, outcome_summary, depends_on, branch, pr_number, status, blocked_reason,
         task_id, created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @scope, @rationale, @acceptance, @expectedKind,
         @outcomeKind, @outcomeRef, @outcomeSummary, @dependsOn, @branch, @prNumber, @status, @blockedReason,
         @taskId, @createdAt, @updatedAt)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, scope=excluded.scope,
         rationale=excluded.rationale, acceptance=excluded.acceptance, expected_kind=excluded.expected_kind,
         depends_on=excluded.depends_on, updated_at=excluded.updated_at`,
    );
    const insertAll = this.ctx.db.transaction((all: PlanPart[]) => {
      for (const p of all) stmt.run({ ...p, dependsOn: JSON.stringify(p.dependsOn) });
    });
    insertAll(rows);
    return rows;
  }

  listPlanParts(planId: string): PlanPart[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_parts WHERE plan_id=? ORDER BY seq ASC, slug ASC`)
      .all(planId) as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

  /** Every part of every plan — what the dispatcher and the reconciler both walk. */
  listAllPlanParts(): PlanPart[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM plan_parts ORDER BY plan_id ASC, seq ASC`).all() as PlanPartRow[];
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
    patch: {
      status?: PlanPart['status'];
      branch?: string | null;
      prNumber?: number | null;
      taskId?: string | null;
      blockedReason?: string | null;
    },
  ): PlanPart | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const next: PlanPart = {
      ...rowToPlanPart(row),
      ...patch,
      updatedAt: this.ctx.now(),
    };
    this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status=@status, branch=@branch, pr_number=@prNumber, task_id=@taskId,
           blocked_reason=@blockedReason, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        branch: next.branch,
        prNumber: next.prNumber,
        taskId: next.taskId,
        blockedReason: next.blockedReason,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  /**
   * A part's agent actually spawned. Called from the executor *after* the spawn, for
   * the same reason `markJobDispatched` is: a dispatch the cap/pause gate holds
   * must leave the part `ready` for a later cycle, not claim it started.
   */
  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.updatePlanPart(id, { status: 'dispatched', taskId, branch });
  }

  /**
   * A part finished without a pull request — it produced a report, or determined
   * that nothing needed building.
   *
   * Its own method rather than an {@link updatePlanPart} patch, because the guard
   * *is* the point: the write is conditional on the part still being worked, so a
   * second call changes nothing and a merged or retired part cannot be re-labelled.
   * Idempotence in the write, not in a read-then-check somebody has to remember —
   * the same discipline as `decideProposal` and `link_ticket`.
   */
  concludePlanPart(
    id: string,
    outcome: { kind: PartOutcomeKind; ref: string | null; summary: string },
  ): PlanPart | null {
    const result = this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status='concluded', outcome_kind=?, outcome_ref=?, outcome_summary=?, updated_at=?
         WHERE id=? AND status IN ('dispatched','in_review')`,
      )
      .run(outcome.kind, outcome.ref, outcome.summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

  /**
   * A part a person owns finished, because the operator marked its human task
   * done. `concluded`, with `outcome_kind='human'` — the record of *what* closed
   * it, which is the whole reason `human` is a kind rather than a flag.
   *
   * Its own method rather than a {@link PlanStore.concludePlanPart} call, because
   * the guards are opposites and both are load-bearing. That one insists the part
   * was `dispatched` or `in_review`, which is exactly right for a part an agent
   * worked and exactly wrong here: a human part is never dispatched at all, so it
   * settles from `pending`, `ready` or `blocked`. Widening the other guard would
   * have let an agent conclude a part nobody had started.
   */
  concludeHumanPart(id: string, summary: string): PlanPart | null {
    const result = this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status='concluded', outcome_kind='human', outcome_summary=?, blocked_reason=NULL,
           updated_at=? WHERE id=? AND status IN ('pending','ready','blocked')`,
      )
      .run(summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

  /**
   * Move a plan to a new status, optionally rewriting the reason that goes with it.
   *
   * `reason` is optional and **preserved on absence**, like every other narrative
   * field on a plan: the planner's own words are what a replan amends, so a
   * transition that had no opinion about them must not clear them. The one caller
   * that passes it is a shortfall's replan arm (issue #159), which appends what an
   * assessment found — the summary reaches the replanning agent through
   * `currentPlanSummary`, which already renders this field, rather than through a
   * new prompt placeholder an operator override could silently drop.
   */
  setPlanStatus(id: string, status: PlanStatus, reason?: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    const next = reason ?? row.reason;
    this.ctx.db
      .prepare(`UPDATE plans SET status=?, reason=?, updated_at=? WHERE id=?`)
      .run(status, next, updatedAt, id);
    return { ...rowToPlan(row), status, reason: next, updatedAt };
  }

  /**
   * Mark a plan as being discussed with an agent, or not. Its own transition
   * rather than a field on {@link upsertPlan}, because ingestion is what *ends* a
   * discussion — folding it in would let an amendment silently re-open one.
   */
  setPlanDiscussing(id: string, discussing: boolean): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE plans SET discussing=?, updated_at=? WHERE id=?`)
      .run(discussing ? 1 : 0, updatedAt, id);
    return { ...rowToPlan(row), discussing, updatedAt };
  }

  /** Remember the provider comment id so the plan's status comment is edited, never re-posted. */
  setPlanStatusComment(id: string, ref: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE plans SET status_comment_ref=?, updated_at=? WHERE id=?`).run(ref, updatedAt, id);
    return { ...rowToPlan(row), statusCommentRef: ref, updatedAt };
  }

  /**
   * Fold a plan's part statuses back onto the plan: every part merged => `complete`,
   * anything outstanding after that => back to `active` (a replan can add work to a
   * finished plan). Returns the plan **only when the roll-up moved it**, so a caller
   * can treat the return as the "the plan just completed" edge rather than re-deriving
   * it. A partless plan — the single-PR arm, or one still `planning` — is never
   * touched: what finishes that arm is the issue's own delivery, not a roll-up. A
   * retired part is not outstanding work — an amended plan that dropped its last
   * unstarted part is complete, not stuck.
   */
  rollUpPlanStatus(planId: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(planId) as PlanRow | undefined;
    if (!row) return null;
    const plan = rowToPlan(row);
    if (plan.status !== 'active' && plan.status !== 'complete') return null;
    const parts = liveParts(this.listPlanParts(planId));
    if (parts.length === 0) return null;
    // Every terminal, not just merges: a part that concluded with a report or a
    // determination is finished, and counting only merges is what held a whole
    // decomposition open on the one part that found nothing to build.
    const next: PlanStatus = parts.every(partSettled) ? 'complete' : 'active';
    if (next === plan.status) return null;
    return this.setPlanStatus(planId, next);
  }
}

/**
 * Absorb the retired `single` plan status into `active`.
 *
 * `single` was a *shape* wearing a lifecycle status, and the two are not
 * exclusive: a plan being delivered as one pull request is still being delivered.
 * Every consumer that switched on status therefore had to know about the shape,
 * and the one that forgot — `PlanReconciler`, which lists only `active`,
 * `complete` and `awaiting_approval` — quietly excluded single-PR plans from
 * reconciliation, so their status comment was never written. The shape is now read
 * off the live parts (`planShape`), which every one of those rows already carries:
 * a `single` plan has none.
 *
 * A data migration rather than an `ensureColumns` entry — no column changes, the
 * values in one do. Unconditional and idempotent: a database with no such rows
 * updates none, and a second boot finds none left.
 */
export function absorbSinglePlanStatus(db: Database.Database): void {
  db.prepare(`UPDATE plans SET status='active' WHERE status='single'`).run();
}

interface PlanRow {
  id: string;
  origin_ref: string;
  title: string;
  status: string;
  reason: string | null;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  diagnosis: string | null | undefined;
  approach: string | null | undefined;
  risks: string | null | undefined;
  out_of_scope: string | null | undefined;
  document: string | null | undefined;
  discussing: number;
  status_comment_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanPartRow {
  id: string;
  plan_id: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  /** Nullable *and* possibly absent: added by `ensureColumns` on databases from an older build. */
  rationale: string | null | undefined;
  acceptance: string | null | undefined;
  expected_kind: string | null | undefined;
  outcome_kind: string | null | undefined;
  outcome_ref: string | null | undefined;
  outcome_summary: string | null | undefined;
  depends_on: string;
  branch: string | null;
  pr_number: number | null;
  status: string;
  blocked_reason: string | null | undefined;
  task_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToPlan(r: PlanRow): Plan {
  return {
    id: r.id,
    originRef: r.origin_ref,
    title: r.title,
    status: r.status as PlanStatus,
    diagnosis: r.diagnosis ?? null,
    approach: r.approach ?? null,
    reason: r.reason,
    risks: r.risks ?? null,
    outOfScope: r.out_of_scope ?? null,
    document: r.document ?? null,
    discussing: r.discussing === 1,
    statusCommentRef: r.status_comment_ref,
    createdAt: r.created_at,
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
    rationale: r.rationale ?? null,
    acceptance: r.acceptance ?? null,
    expectedKind: partOutcomeKindOf(r.expected_kind),
    outcomeKind: partOutcomeKindOf(r.outcome_kind),
    outcomeRef: r.outcome_ref ?? null,
    outcomeSummary: r.outcome_summary ?? null,
    // Written as JSON by upsertPlanParts; a corrupt value degrades to "no deps"
    // rather than throwing the whole snapshot away.
    dependsOn: parseDependsOn(r.depends_on),
    branch: r.branch,
    prNumber: r.pr_number,
    status: r.status as PlanPart['status'],
    blockedReason: r.blocked_reason ?? null,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Narrowed rather than cast: these two columns are absent on older databases and
 * are the only part of the row a *human* can edit by hand, so an unrecognised
 * value degrades to "unstated" instead of putting a status nothing switches on
 * into the type.
 *
 * **A new {@link PartOutcomeKind} must be added here too**, and that is a sharp
 * edge rather than a chore: this narrowing is not a type guard the compiler
 * checks against the union, so a kind missing from it is written to SQLite, read
 * back as `null`, and silently reads as `code` everywhere downstream — a step for
 * a person would be handed to an agent. It cost one test to find and would have
 * cost a fleet to find in production.
 */
function partOutcomeKindOf(raw: string | null | undefined): PartOutcomeKind | null {
  return raw === 'code' || raw === 'report' || raw === 'determination' || raw === 'human' ? raw : null;
}

function parseDependsOn(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
