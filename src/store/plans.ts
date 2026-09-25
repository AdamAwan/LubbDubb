import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { liveParts, partSettled } from '../plans/parts.js';
import type {
  PartOutcomeKind,
  PlanAtom,
  PlanAtomInput,
  Plan,
  PlanEvidence,
  PlanAmendment,
  PlanAmendmentAuthor,
  PlanAmendmentStatus,
  PlanCaveatAnswer,
  PlanNarrative,
  PlanPart,
  PlanPartInput,
  PlanRevision,
  PlanStatus,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import { labelsById, type StoreContext } from './context.js';
import {
  rowToAmendment,
  rowToCaveatAnswer,
  rowToPlan,
  rowToPlanAtom,
  rowToPlanPart,
  rowToRevision,
  type PlanAmendmentRow,
  type PlanAtomRow,
  type PlanCaveatAnswerRow,
  type PlanPartRow,
  type PlanRevisionRow,
  type PlanRow,
} from './rows/plans.js';
import { keptProse, redeclaredPart } from '../plans/redeclare.js';

// → docs/spec/14-persistence.md

export const PLAN_COLUMNS: ColumnMigrations = {
  plans: {
    diagnosis: 'TEXT',
    approach: 'TEXT',
    risks: 'TEXT',
    out_of_scope: 'TEXT',
    alternatives: 'TEXT',
    open_questions: 'TEXT',
    verification: 'TEXT',
    evidence: 'TEXT',
    document: 'TEXT',
    discussing: 'INTEGER NOT NULL DEFAULT 0',
  },
  plan_atoms: {
    touches: 'TEXT',
    acceptance: 'TEXT',
    rejected: 'TEXT',
  },
  plan_parts: {
    touches: 'TEXT',
    atoms: 'TEXT',
    rationale: 'TEXT',
    acceptance: 'TEXT',
    acceptance_met: 'TEXT',
    size: 'TEXT',
    expected_kind: 'TEXT',
    profile: 'TEXT',
    coverage: 'TEXT',
    outcome_kind: 'TEXT',
    outcome_ref: 'TEXT',
    outcome_summary: 'TEXT',
    blocked_reason: 'TEXT',
    blocked_by: 'TEXT',
  },
};

export class PlanStore {
  constructor(private readonly ctx: StoreContext) {}

  upsertPlan(input: {
    originRef: string;
    title: string;
    status: PlanStatus;
    diagnosis?: string | null;
    approach?: string | null;
    reason?: string | null;
    risks?: string | null;
    outOfScope?: string | null;
    alternatives?: string | null;
    openQuestions?: string | null;
    verification?: string | null;
    evidence?: PlanEvidence[] | null;
    document?: string | null;
    statusCommentRef?: string | null;
  }): Plan {
    const existing = this.getPlanByOrigin(input.originRef);
    const ts = this.ctx.now();
    const kept = keptProse(input, existing);
    const plan: Plan = {
      id: existing?.id ?? `plan_${nanoid(10)}`,
      originRef: input.originRef,
      title: input.title,
      status: input.status,
      reason: input.reason ?? null,
      diagnosis: kept.diagnosis,
      approach: kept.approach,
      risks: kept.risks,
      outOfScope: kept.outOfScope,
      alternatives: kept.alternatives,
      openQuestions: kept.openQuestions,
      verification: kept.verification,
      evidence: input.evidence ?? existing?.evidence ?? [],
      document: kept.document,
      statusCommentRef: kept.statusCommentRef,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.ctx
      .prep(
        `INSERT INTO plans (id, origin_ref, title, status, diagnosis, approach, reason, risks, out_of_scope,
           alternatives, open_questions, verification, evidence, document, status_comment_ref,
           created_at, updated_at)
         VALUES (@id, @originRef, @title, @status, @diagnosis, @approach, @reason, @risks, @outOfScope,
           @alternatives, @openQuestions, @verification, @evidence, @document, @statusCommentRef,
           @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET title=excluded.title, status=excluded.status,
           diagnosis=excluded.diagnosis, approach=excluded.approach,
           reason=excluded.reason, risks=excluded.risks, out_of_scope=excluded.out_of_scope,
           alternatives=excluded.alternatives, open_questions=excluded.open_questions,
           verification=excluded.verification, evidence=excluded.evidence,
           document=excluded.document, status_comment_ref=excluded.status_comment_ref, updated_at=excluded.updated_at`,
      )
      .run({ ...plan, evidence: JSON.stringify(plan.evidence) });
    return plan;
  }

  recordPlanRevision(planId: string, input: { narrative: PlanNarrative; parts: PlanPartInput[] }): PlanRevision {
    const at = this.ctx.now();
    const row = this.ctx.prep(`SELECT MAX(seq) AS seq FROM plan_revisions WHERE plan_id=?`).get(planId) as
      | { seq: number | null }
      | undefined;
    const revision: PlanRevision = {
      id: `rev_${nanoid(10)}`,
      planId,
      seq: (row?.seq ?? 0) + 1,
      narrative: input.narrative,
      parts: input.parts,
      at,
    };
    this.ctx
      .prep(
        `INSERT INTO plan_revisions (id, plan_id, seq, verdict, narrative, parts, at)
         VALUES (@id, @planId, @seq, @verdict, @narrative, @parts, @at)`,
      )
      .run({
        ...revision,
        verdict: 'parts',
        narrative: JSON.stringify(revision.narrative),
        parts: JSON.stringify(revision.parts),
      });
    return revision;
  }

  listPlanRevisions(planId: string): PlanRevision[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY seq ASC`)
      .all(planId) as PlanRevisionRow[];
    return rows.map(rowToRevision);
  }

  recordPlanCaveatAnswers(
    planId: string,
    answers: readonly { caveatId: string; label: string; answer: string }[],
  ): PlanCaveatAnswer[] {
    const at = this.ctx.now();
    const written = answers.map((a) => ({ id: `pca_${nanoid(10)}`, planId, ...a, at }));
    const insert = this.ctx.prep(
      `INSERT INTO plan_caveat_answers (id, plan_id, caveat_id, label, answer, at)
       VALUES (@id, @planId, @caveatId, @label, @answer, @at)`,
    );
    for (const row of written) insert.run(row);
    return written;
  }

  listPlanCaveatAnswers(planId: string): PlanCaveatAnswer[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_caveat_answers WHERE plan_id=? ORDER BY at ASC, id ASC`)
      .all(planId) as PlanCaveatAnswerRow[];
    return rows.map(rowToCaveatAnswer);
  }

  listAllPlanCaveatAnswers(): PlanCaveatAnswer[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_caveat_answers ORDER BY at ASC, id ASC`)
      .all() as PlanCaveatAnswerRow[];
    return rows.map(rowToCaveatAnswer);
  }

  recordPlanAmendment(input: {
    planId: string;
    originRef: string;
    document: string;
    note: string;
    author: PlanAmendmentAuthor;
    authorRef: string | null;
  }): PlanAmendment {
    const at = this.ctx.now();
    const amendment: PlanAmendment = {
      id: `amd_${nanoid(10)}`,
      ...input,
      status: 'pending',
      resolution: null,
      createdAt: at,
      decidedAt: null,
    };
    this.ctx
      .prep(
        `INSERT INTO plan_amendments (id, plan_id, origin_ref, document, note, author, author_ref, status,
           resolution, created_at, decided_at)
         VALUES (@id, @planId, @originRef, @document, @note, @author, @authorRef, @status, @resolution,
           @createdAt, @decidedAt)`,
      )
      .run(amendment);
    return amendment;
  }

  getPlanAmendment(id: string): PlanAmendment | null {
    const row = this.ctx.prep(`SELECT * FROM plan_amendments WHERE id=?`).get(id) as PlanAmendmentRow | undefined;
    return row ? rowToAmendment(row) : null;
  }

  listPlanAmendments(planId: string): PlanAmendment[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_amendments WHERE plan_id=? ORDER BY created_at DESC`)
      .all(planId) as PlanAmendmentRow[];
    return rows.map(rowToAmendment);
  }

  listAllPlanAmendments(): PlanAmendment[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_amendments ORDER BY plan_id ASC, created_at DESC`)
      .all() as PlanAmendmentRow[];
    return rows.map(rowToAmendment);
  }

  listPendingPlanAmendments(): PlanAmendment[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_amendments WHERE status='pending' ORDER BY created_at ASC`)
      .all() as PlanAmendmentRow[];
    return rows.map(rowToAmendment);
  }

  settlePlanAmendment(
    id: string,
    status: Exclude<PlanAmendmentStatus, 'pending'>,
    resolution: string,
  ): PlanAmendment | null {
    const row = this.ctx.prep(`SELECT * FROM plan_amendments WHERE id=?`).get(id) as PlanAmendmentRow | undefined;
    if (!row || row.status !== 'pending') return null;
    const at = this.ctx.now();
    this.ctx
      .prep(`UPDATE plan_amendments SET status=?, resolution=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(status, resolution, at, id);
    return { ...rowToAmendment(row), status, resolution, decidedAt: at };
  }

  getPlan(id: string): Plan | null {
    const row = this.ctx.prep(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  planLabels(ids: string[]): Map<string, string> {
    return labelsById(this.ctx, 'plans', ids);
  }

  getPlanByOrigin(originRef: string): Plan | null {
    const row = this.ctx.prep(`SELECT * FROM plans WHERE origin_ref=?`).get(originRef) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listPlans(): Plan[] {
    const rows = this.ctx.prep(`SELECT * FROM plans ORDER BY created_at ASC`).all() as PlanRow[];
    return rows.map(rowToPlan);
  }

  upsertPlanParts(planId: string, parts: PlanPartInput[]): PlanPart[] {
    const ts = this.ctx.now();
    const existing = new Map(this.listPlanParts(planId).map((p) => [p.slug, p]));
    const rows = parts.map((input) => redeclaredPart(planId, input, existing.get(input.slug), ts));
    const stmt = this.ctx.prep(
      `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, touches, atoms, rationale, acceptance,
         acceptance_met, size, expected_kind, profile, coverage,
         outcome_kind, outcome_ref, outcome_summary, depends_on, branch, pr_number, status, blocked_reason,
         blocked_by, task_id, created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @scope, @touches, @atoms, @rationale, @acceptance,
         @acceptanceMet, @size, @expectedKind, @profile, @coverage,
         @outcomeKind, @outcomeRef, @outcomeSummary, @dependsOn, @branch, @prNumber, @status, @blockedReason,
         @blockedBy, @taskId, @createdAt, @updatedAt)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, scope=excluded.scope,
         touches=excluded.touches, atoms=excluded.atoms, rationale=excluded.rationale, acceptance=excluded.acceptance,
         size=excluded.size, expected_kind=excluded.expected_kind, profile=excluded.profile,
         coverage=excluded.coverage,
         depends_on=excluded.depends_on, status=excluded.status,
         blocked_reason=excluded.blocked_reason, blocked_by=excluded.blocked_by,
         updated_at=excluded.updated_at`,
    );
    const insertAll = this.ctx.db.transaction((all: PlanPart[]) => {
      for (const p of all)
        stmt.run({
          ...p,
          dependsOn: JSON.stringify(p.dependsOn),
          touches: JSON.stringify(p.touches),
          atoms: p.atoms === undefined ? null : JSON.stringify(p.atoms),
          acceptanceMet: JSON.stringify(p.acceptanceMet),
        });
    });
    insertAll(rows);
    return rows;
  }

  listPlanParts(planId: string): PlanPart[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_parts WHERE plan_id=? ORDER BY seq ASC, slug ASC`)
      .all(planId) as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

  upsertPlanAtoms(planId: string, atoms: PlanAtomInput[]): PlanAtom[] {
    const ts = this.ctx.now();
    const rows: PlanAtom[] = atoms.map((atom) => ({ id: `${planId}:${atom.slug}`, planId, ...atom }));
    const stmt = this.ctx.prep(
      `INSERT INTO plan_atoms (id, plan_id, slug, seq, title, intent, touches, acceptance, depends_on, rejected,
         created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @intent, @touches, @acceptance, @dependsOn, @rejected, @at, @at)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, intent=excluded.intent,
         touches=excluded.touches, acceptance=excluded.acceptance, depends_on=excluded.depends_on,
         rejected=excluded.rejected, updated_at=excluded.updated_at`,
    );
    const write = this.ctx.db.transaction((all: PlanAtom[]) => {
      const keep = all.map((a) => a.slug);
      const holes = keep.map(() => '?').join(',');
      this.ctx.db
        .prepare(
          keep.length === 0
            ? `DELETE FROM plan_atoms WHERE plan_id=?`
            : `DELETE FROM plan_atoms WHERE plan_id=? AND slug NOT IN (${holes})`,
        )
        .run(planId, ...keep);
      for (const atom of all)
        stmt.run({
          ...atom,
          touches: JSON.stringify(atom.touches),
          dependsOn: JSON.stringify(atom.dependsOn),
          rejected: JSON.stringify(atom.rejected),
          at: ts,
        });
    });
    write(rows);
    return rows;
  }

  listPlanAtoms(planId: string): PlanAtom[] {
    const rows = this.ctx
      .prep(`SELECT * FROM plan_atoms WHERE plan_id=? ORDER BY seq ASC`)
      .all(planId) as PlanAtomRow[];
    return rows.map(rowToPlanAtom);
  }

  listAllPlanAtoms(): PlanAtom[] {
    const rows = this.ctx.prep(`SELECT * FROM plan_atoms ORDER BY plan_id ASC, seq ASC`).all() as PlanAtomRow[];
    return rows.map(rowToPlanAtom);
  }

  listAllPlanParts(): PlanPart[] {
    const rows = this.ctx.prep(`SELECT * FROM plan_parts ORDER BY plan_id ASC, seq ASC`).all() as PlanPartRow[];
    return rows.map(rowToPlanPart);
  }

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
    const row = this.ctx.prep(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const next: PlanPart = {
      ...rowToPlanPart(row),
      ...patch,
      updatedAt: this.ctx.now(),
    };
    this.ctx
      .prep(
        `UPDATE plan_parts SET status=@status, branch=@branch, pr_number=@prNumber, task_id=@taskId,
           blocked_reason=@blockedReason, blocked_by=@blockedBy, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({
        id: next.id,
        status: next.status,
        branch: next.branch,
        prNumber: next.prNumber,
        taskId: next.taskId,
        blockedReason: next.blockedReason,
        blockedBy: next.blockedBy,
        updatedAt: next.updatedAt,
      });
    return next;
  }

  setPartAcceptanceMet(id: string, criteria: string[]): PlanPart | null {
    const row = this.ctx.prep(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx
      .prep(`UPDATE plan_parts SET acceptance_met=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(criteria), updatedAt, id);
    return { ...rowToPlanPart(row), acceptanceMet: criteria, updatedAt };
  }

  setPartProfile(id: string, profile: string | null): PlanPart | null {
    const row = this.ctx.prep(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.prep(`UPDATE plan_parts SET profile=?, updated_at=? WHERE id=?`).run(profile, updatedAt, id);
    return { ...rowToPlanPart(row), profile, updatedAt };
  }

  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.updatePlanPart(id, { status: 'dispatched', taskId, branch });
  }

  concludePlanPart(
    id: string,
    outcome: { kind: PartOutcomeKind; ref: string | null; summary: string },
  ): PlanPart | null {
    const result = this.ctx
      .prep(
        `UPDATE plan_parts SET status='concluded', outcome_kind=?, outcome_ref=?, outcome_summary=?, updated_at=?
         WHERE id=? AND status IN ('dispatched','in_review')`,
      )
      .run(outcome.kind, outcome.ref, outcome.summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.prep(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

  concludeHumanPart(id: string, summary: string): PlanPart | null {
    const result = this.ctx
      .prep(
        `UPDATE plan_parts SET status='concluded', outcome_kind='human', outcome_summary=?, blocked_reason=NULL,
           blocked_by=NULL, updated_at=? WHERE id=? AND status IN ('pending','ready','blocked')`,
      )
      .run(summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.prep(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

  setPlanStatus(id: string, status: PlanStatus, reason?: string): Plan | null {
    const row = this.ctx.prep(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    const next = reason ?? row.reason;
    this.ctx.prep(`UPDATE plans SET status=?, reason=?, updated_at=? WHERE id=?`).run(status, next, updatedAt, id);
    return { ...rowToPlan(row), status, reason: next, updatedAt };
  }

  setPlanStatusComment(id: string, ref: string): Plan | null {
    const row = this.ctx.prep(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.prep(`UPDATE plans SET status_comment_ref=?, updated_at=? WHERE id=?`).run(ref, updatedAt, id);
    return { ...rowToPlan(row), statusCommentRef: ref, updatedAt };
  }

  rollUpPlanStatus(planId: string): Plan | null {
    const row = this.ctx.prep(`SELECT * FROM plans WHERE id=?`).get(planId) as PlanRow | undefined;
    if (!row) return null;
    const plan = rowToPlan(row);
    if (plan.status !== 'active' && plan.status !== 'complete') return null;
    const parts = liveParts(this.listPlanParts(planId));
    if (parts.length === 0) return null;
    const next: PlanStatus = parts.every(partSettled) ? 'complete' : 'active';
    if (next === plan.status) return null;
    return this.setPlanStatus(planId, next);
  }
}

export function absorbSinglePlanStatus(db: Database.Database): void {
  db.prepare(`UPDATE plans SET status='active' WHERE status='single'`).run();
}

export function backfillWholePlanParts(db: Database.Database, now: string): void {
  const orphans = db
    .prepare(
      `SELECT id, origin_ref, title, status FROM plans
        WHERE status <> 'abandoned'
          AND id NOT IN (SELECT DISTINCT plan_id FROM plan_parts)`,
    )
    .all() as { id: string; origin_ref: string; title: string; status: string }[];
  const insert = db.prepare(
    `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, touches, rationale, acceptance,
       acceptance_met, size, expected_kind, profile, outcome_kind, outcome_ref, outcome_summary,
       depends_on, branch, pr_number, status, blocked_reason, blocked_by, task_id, created_at, updated_at)
     VALUES (@id, @planId, @slug, 1, @title, @scope, '[]', NULL, NULL,
       '[]', NULL, NULL, NULL, NULL, NULL, NULL,
       '[]', @branch, NULL, @status, NULL, NULL, NULL, @at, @at)`,
  );
  for (const plan of orphans) {
    const issueNumber = Number(/^issue:(\d+)$/.exec(plan.origin_ref)?.[1]);
    if (!Number.isFinite(issueNumber)) continue;
    const started = plan.status === 'active' || plan.status === 'complete';
    insert.run({
      id: `${plan.id}:${WHOLE_PART_SLUG}`,
      planId: plan.id,
      slug: WHOLE_PART_SLUG,
      title: plan.title,
      scope: 'The whole issue — this plan was written before a plan had parts.',
      branch: started ? `issue/${issueNumber}` : null,
      status: plan.status === 'complete' ? 'merged' : 'ready',
      at: now,
    });
  }
}

const WHOLE_PART_SLUG = 'whole';
