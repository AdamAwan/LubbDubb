import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { liveParts, partSettled } from '../plans/parts.js';
import type {
  PartOutcomeKind,
  PartSize,
  Plan,
  PlanEvidence,
  PlanAmendment,
  PlanAmendmentAuthor,
  PlanAmendmentStatus,
  PlanCaveatAnswer,
  PlanNarrative,
  PlanPart,
  PlanPartBlocker,
  PlanPartInput,
  PlanRevision,
  PlanStatus,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

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
  plan_parts: {
    touches: 'TEXT',
    rationale: 'TEXT',
    acceptance: 'TEXT',
    acceptance_met: 'TEXT',
    size: 'TEXT',
    expected_kind: 'TEXT',
    profile: 'TEXT',
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
    const plan: Plan = {
      id: existing?.id ?? `plan_${nanoid(10)}`,
      originRef: input.originRef,
      title: input.title,
      status: input.status,
      reason: input.reason ?? null,
      diagnosis: input.diagnosis ?? existing?.diagnosis ?? null,
      approach: input.approach ?? existing?.approach ?? null,
      risks: input.risks ?? existing?.risks ?? null,
      outOfScope: input.outOfScope ?? existing?.outOfScope ?? null,
      alternatives: input.alternatives ?? existing?.alternatives ?? null,
      openQuestions: input.openQuestions ?? existing?.openQuestions ?? null,
      verification: input.verification ?? existing?.verification ?? null,
      evidence: input.evidence ?? existing?.evidence ?? [],
      document: input.document ?? existing?.document ?? null,
      statusCommentRef: input.statusCommentRef ?? existing?.statusCommentRef ?? null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    };
    this.ctx.db
      .prepare(
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
    const row = this.ctx.db.prepare(`SELECT MAX(seq) AS seq FROM plan_revisions WHERE plan_id=?`).get(planId) as
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
    this.ctx.db
      .prepare(
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
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_revisions WHERE plan_id=? ORDER BY seq ASC`)
      .all(planId) as PlanRevisionRow[];
    return rows.map(rowToRevision);
  }

  recordPlanCaveatAnswers(
    planId: string,
    answers: readonly { caveatId: string; label: string; answer: string }[],
  ): PlanCaveatAnswer[] {
    const at = this.ctx.now();
    const written = answers.map((a) => ({ id: `pca_${nanoid(10)}`, planId, ...a, at }));
    const insert = this.ctx.db.prepare(
      `INSERT INTO plan_caveat_answers (id, plan_id, caveat_id, label, answer, at)
       VALUES (@id, @planId, @caveatId, @label, @answer, @at)`,
    );
    for (const row of written) insert.run(row);
    return written;
  }

  listPlanCaveatAnswers(planId: string): PlanCaveatAnswer[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_caveat_answers WHERE plan_id=? ORDER BY at ASC, id ASC`)
      .all(planId) as PlanCaveatAnswerRow[];
    return rows.map(rowToCaveatAnswer);
  }

  listAllPlanCaveatAnswers(): PlanCaveatAnswer[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_caveat_answers ORDER BY at ASC, id ASC`)
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
    this.ctx.db
      .prepare(
        `INSERT INTO plan_amendments (id, plan_id, origin_ref, document, note, author, author_ref, status,
           resolution, created_at, decided_at)
         VALUES (@id, @planId, @originRef, @document, @note, @author, @authorRef, @status, @resolution,
           @createdAt, @decidedAt)`,
      )
      .run(amendment);
    return amendment;
  }

  getPlanAmendment(id: string): PlanAmendment | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_amendments WHERE id=?`).get(id) as PlanAmendmentRow | undefined;
    return row ? rowToAmendment(row) : null;
  }

  listPlanAmendments(planId: string): PlanAmendment[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_amendments WHERE plan_id=? ORDER BY created_at DESC`)
      .all(planId) as PlanAmendmentRow[];
    return rows.map(rowToAmendment);
  }

  listPendingPlanAmendments(): PlanAmendment[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM plan_amendments WHERE status='pending' ORDER BY created_at ASC`)
      .all() as PlanAmendmentRow[];
    return rows.map(rowToAmendment);
  }

  settlePlanAmendment(
    id: string,
    status: Exclude<PlanAmendmentStatus, 'pending'>,
    resolution: string,
  ): PlanAmendment | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_amendments WHERE id=?`).get(id) as PlanAmendmentRow | undefined;
    if (!row || row.status !== 'pending') return null;
    const at = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE plan_amendments SET status=?, resolution=?, decided_at=? WHERE id=? AND status='pending'`)
      .run(status, resolution, at, id);
    return { ...rowToAmendment(row), status, resolution, decidedAt: at };
  }

  getPlan(id: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  planLabels(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const holes = ids.map(() => '?').join(',');
    const rows = this.ctx.db.prepare(`SELECT id, title FROM plans WHERE id IN (${holes})`).all(...ids) as {
      id: string;
      title: string;
    }[];
    return new Map(rows.map((r) => [r.id, r.title]));
  }

  getPlanByOrigin(originRef: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE origin_ref=?`).get(originRef) as PlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listPlans(): Plan[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM plans ORDER BY created_at ASC`).all() as PlanRow[];
    return rows.map(rowToPlan);
  }

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
        touches: input.touches,
        rationale: input.rationale,
        acceptance: input.acceptance,
        acceptanceMet: prev?.acceptanceMet ?? [],
        size: input.size,
        expectedKind: input.expectedKind,
        profile: input.profile,
        outcomeKind: prev?.outcomeKind ?? null,
        outcomeRef: prev?.outcomeRef ?? null,
        outcomeSummary: prev?.outcomeSummary ?? null,
        dependsOn: input.dependsOn,
        branch: prev?.branch ?? null,
        prNumber: prev?.prNumber ?? null,
        status: prev?.status === 'retired' ? 'pending' : (prev?.status ?? 'pending'),
        blockedReason: prev?.status === 'retired' ? null : (prev?.blockedReason ?? null),
        blockedBy: prev?.status === 'retired' ? null : (prev?.blockedBy ?? null),
        taskId: prev?.taskId ?? null,
        createdAt: prev?.createdAt ?? ts,
        updatedAt: ts,
      };
      return part;
    });
    const stmt = this.ctx.db.prepare(
      `INSERT INTO plan_parts (id, plan_id, slug, seq, title, scope, touches, rationale, acceptance,
         acceptance_met, size, expected_kind, profile,
         outcome_kind, outcome_ref, outcome_summary, depends_on, branch, pr_number, status, blocked_reason,
         blocked_by, task_id, created_at, updated_at)
       VALUES (@id, @planId, @slug, @seq, @title, @scope, @touches, @rationale, @acceptance,
         @acceptanceMet, @size, @expectedKind, @profile,
         @outcomeKind, @outcomeRef, @outcomeSummary, @dependsOn, @branch, @prNumber, @status, @blockedReason,
         @blockedBy, @taskId, @createdAt, @updatedAt)
       ON CONFLICT(plan_id, slug) DO UPDATE SET seq=excluded.seq, title=excluded.title, scope=excluded.scope,
         touches=excluded.touches, rationale=excluded.rationale, acceptance=excluded.acceptance,
         size=excluded.size, expected_kind=excluded.expected_kind, profile=excluded.profile,
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
          acceptanceMet: JSON.stringify(p.acceptanceMet),
        });
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

  listAllPlanParts(): PlanPart[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM plan_parts ORDER BY plan_id ASC, seq ASC`).all() as PlanPartRow[];
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
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db
      .prepare(`UPDATE plan_parts SET acceptance_met=?, updated_at=? WHERE id=?`)
      .run(JSON.stringify(criteria), updatedAt, id);
    return { ...rowToPlanPart(row), acceptanceMet: criteria, updatedAt };
  }

  setPartProfile(id: string, profile: string | null): PlanPart | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE plan_parts SET profile=?, updated_at=? WHERE id=?`).run(profile, updatedAt, id);
    return { ...rowToPlanPart(row), profile, updatedAt };
  }

  markPartDispatched(id: string, taskId: string, branch: string): PlanPart | null {
    return this.updatePlanPart(id, { status: 'dispatched', taskId, branch });
  }

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

  concludeHumanPart(id: string, summary: string): PlanPart | null {
    const result = this.ctx.db
      .prepare(
        `UPDATE plan_parts SET status='concluded', outcome_kind='human', outcome_summary=?, blocked_reason=NULL,
           blocked_by=NULL, updated_at=? WHERE id=? AND status IN ('pending','ready','blocked')`,
      )
      .run(summary, this.ctx.now(), id);
    if (result.changes === 0) return null;
    const row = this.ctx.db.prepare(`SELECT * FROM plan_parts WHERE id=?`).get(id) as PlanPartRow | undefined;
    return row ? rowToPlanPart(row) : null;
  }

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

  setPlanStatusComment(id: string, ref: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(id) as PlanRow | undefined;
    if (!row) return null;
    const updatedAt = this.ctx.now();
    this.ctx.db.prepare(`UPDATE plans SET status_comment_ref=?, updated_at=? WHERE id=?`).run(ref, updatedAt, id);
    return { ...rowToPlan(row), statusCommentRef: ref, updatedAt };
  }

  rollUpPlanStatus(planId: string): Plan | null {
    const row = this.ctx.db.prepare(`SELECT * FROM plans WHERE id=?`).get(planId) as PlanRow | undefined;
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

interface PlanRow {
  id: string;
  origin_ref: string;
  title: string;
  status: string;
  reason: string | null;
  diagnosis: string | null | undefined;
  approach: string | null | undefined;
  risks: string | null | undefined;
  out_of_scope: string | null | undefined;
  alternatives: string | null | undefined;
  open_questions: string | null | undefined;
  verification: string | null | undefined;
  evidence: string | null | undefined;
  document: string | null | undefined;
  status_comment_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanRevisionRow {
  id: string;
  plan_id: string;
  seq: number;
  verdict: string;
  narrative: string;
  parts: string;
  at: string;
}

interface PlanAmendmentRow {
  id: string;
  plan_id: string;
  origin_ref: string;
  document: string;
  note: string;
  author: string;
  author_ref: string | null;
  status: string;
  resolution: string | null;
  created_at: string;
  decided_at: string | null;
}

interface PlanCaveatAnswerRow {
  id: string;
  plan_id: string;
  caveat_id: string;
  label: string;
  answer: string;
  at: string;
}

interface PlanPartRow {
  id: string;
  plan_id: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  touches: string | null | undefined;
  rationale: string | null | undefined;
  acceptance: string | null | undefined;
  acceptance_met: string | null | undefined;
  size: string | null | undefined;
  expected_kind: string | null | undefined;
  profile: string | null | undefined;
  outcome_kind: string | null | undefined;
  outcome_ref: string | null | undefined;
  outcome_summary: string | null | undefined;
  depends_on: string;
  branch: string | null;
  pr_number: number | null;
  status: string;
  blocked_reason: string | null | undefined;
  blocked_by: string | null | undefined;
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
    alternatives: r.alternatives ?? null,
    openQuestions: r.open_questions ?? null,
    verification: r.verification ?? null,
    evidence: parseEvidence(r.evidence),
    document: r.document ?? null,
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
    touches: parseStringArray(r.touches),
    rationale: r.rationale ?? null,
    acceptance: r.acceptance ?? null,
    acceptanceMet: parseStringArray(r.acceptance_met),
    size: partSizeOf(r.size),
    expectedKind: partOutcomeKindOf(r.expected_kind),
    profile: r.profile ?? null,
    outcomeKind: partOutcomeKindOf(r.outcome_kind),
    outcomeRef: r.outcome_ref ?? null,
    outcomeSummary: r.outcome_summary ?? null,
    dependsOn: parseDependsOn(r.depends_on),
    branch: r.branch,
    prNumber: r.pr_number,
    status: r.status as PlanPart['status'],
    blockedReason: r.blocked_reason ?? null,
    blockedBy: partBlockerOf(r.blocked_by),
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function partOutcomeKindOf(raw: string | null | undefined): PartOutcomeKind | null {
  return raw === 'code' || raw === 'report' || raw === 'determination' || raw === 'human' ? raw : null;
}

function partSizeOf(raw: string | null | undefined): PartSize | null {
  return raw === 's' || raw === 'm' || raw === 'l' ? raw : null;
}

function partBlockerOf(raw: string | null | undefined): PlanPartBlocker | null {
  return raw === 'collision' || raw === 'declined' ? raw : null;
}

function parseDependsOn(raw: string): string[] {
  return parseStringArray(raw);
}

function parseStringArray(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function parseEvidence(raw: string | null | undefined): PlanEvidence[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): PlanEvidence[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { path, line, note } = entry as Record<string, unknown>;
      if (typeof path !== 'string' || path === '') return [];
      return [
        {
          path,
          line: typeof line === 'number' ? line : null,
          note: typeof note === 'string' ? note : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

function rowToAmendment(r: PlanAmendmentRow): PlanAmendment {
  return {
    id: r.id,
    planId: r.plan_id,
    originRef: r.origin_ref,
    document: r.document,
    note: r.note,
    author: r.author === 'operator' ? 'operator' : 'agent',
    authorRef: r.author_ref,
    status: AMENDMENT_STATUSES.includes(r.status as PlanAmendmentStatus)
      ? (r.status as PlanAmendmentStatus)
      : 'pending',
    resolution: r.resolution,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

function rowToCaveatAnswer(r: PlanCaveatAnswerRow): PlanCaveatAnswer {
  return {
    id: r.id,
    planId: r.plan_id,
    caveatId: r.caveat_id,
    label: r.label,
    answer: r.answer,
    at: r.at,
  };
}

const AMENDMENT_STATUSES: PlanAmendmentStatus[] = ['pending', 'applied', 'declined', 'superseded'];

function rowToRevision(r: PlanRevisionRow): PlanRevision {
  return {
    id: r.id,
    planId: r.plan_id,
    seq: r.seq,
    narrative: parseNarrative(r.narrative),
    parts: parseRevisionParts(r.parts),
    at: r.at,
  };
}

function parseNarrative(raw: string): PlanNarrative {
  const empty: PlanNarrative = {
    reason: null,
    diagnosis: null,
    approach: null,
    risks: null,
    outOfScope: null,
    alternatives: null,
    openQuestions: null,
    verification: null,
    document: null,
    evidence: [],
  };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const bag = parsed as Record<string, unknown>;
    const text = (key: keyof PlanNarrative): string | null => (typeof bag[key] === 'string' ? bag[key] : null);
    return {
      reason: text('reason'),
      diagnosis: text('diagnosis'),
      approach: text('approach'),
      risks: text('risks'),
      outOfScope: text('outOfScope'),
      alternatives: text('alternatives'),
      openQuestions: text('openQuestions'),
      verification: text('verification'),
      document: text('document'),
      evidence: parseEvidence(JSON.stringify(bag.evidence ?? [])),
    };
  } catch {
    return empty;
  }
}

function parseRevisionParts(raw: string): PlanPartInput[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry, index): PlanPartInput[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const bag = entry as Record<string, unknown>;
      if (typeof bag.slug !== 'string' || bag.slug === '') return [];
      const text = (key: string): string | null => (typeof bag[key] === 'string' ? bag[key] : null);
      return [
        {
          slug: bag.slug,
          seq: typeof bag.seq === 'number' ? bag.seq : index + 1,
          title: text('title') ?? bag.slug,
          scope: text('scope') ?? '',
          touches: parseStringArray(JSON.stringify(bag.touches ?? [])),
          dependsOn: parseStringArray(JSON.stringify(bag.dependsOn ?? [])),
          rationale: text('rationale'),
          acceptance: text('acceptance'),
          size: partSizeOf(text('size')),
          expectedKind: partOutcomeKindOf(text('expectedKind')),
          profile: text('profile'),
        },
      ];
    });
  } catch {
    return [];
  }
}
