import type {
  PartOutcomeKind,
  PlanAtom,
  PlanAtomRejection,
  PartSize,
  Plan,
  PlanEvidence,
  PlanAmendment,
  PlanAmendmentStatus,
  PlanCaveatAnswer,
  PlanNarrative,
  PlanPart,
  PlanPartBlocker,
  PlanPartInput,
  PlanRevision,
  PlanStatus,
} from '../../types.js';

export interface PlanRow {
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

export interface PlanRevisionRow {
  id: string;
  plan_id: string;
  seq: number;
  verdict: string;
  narrative: string;
  parts: string;
  at: string;
}

export interface PlanAmendmentRow {
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

export interface PlanCaveatAnswerRow {
  id: string;
  plan_id: string;
  caveat_id: string;
  label: string;
  answer: string;
  at: string;
}

export interface PlanPartRow {
  id: string;
  plan_id: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  touches: string | null | undefined;
  atoms: string | null | undefined;
  rationale: string | null | undefined;
  acceptance: string | null | undefined;
  acceptance_met: string | null | undefined;
  size: string | null | undefined;
  expected_kind: string | null | undefined;
  profile: string | null | undefined;
  coverage: string | null | undefined;
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

export function rowToPlan(r: PlanRow): Plan {
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

export function rowToPlanPart(r: PlanPartRow): PlanPart {
  return {
    id: r.id,
    planId: r.plan_id,
    slug: r.slug,
    seq: r.seq,
    title: r.title,
    scope: r.scope,
    touches: parseStringArray(r.touches),
    atoms: r.atoms === null || r.atoms === undefined ? undefined : parseStringArray(r.atoms),
    rationale: r.rationale ?? null,
    acceptance: r.acceptance ?? null,
    acceptanceMet: parseStringArray(r.acceptance_met),
    size: partSizeOf(r.size),
    expectedKind: partOutcomeKindOf(r.expected_kind),
    profile: r.profile ?? null,
    coverage: r.coverage ?? null,
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

export interface PlanAtomRow {
  id: string;
  plan_id: string;
  slug: string;
  seq: number;
  title: string;
  intent: string;
  touches: string | null | undefined;
  acceptance: string | null | undefined;
  depends_on: string;
  rejected: string | null | undefined;
}

export function rowToPlanAtom(r: PlanAtomRow): PlanAtom {
  return {
    id: r.id,
    planId: r.plan_id,
    slug: r.slug,
    seq: r.seq,
    title: r.title,
    intent: r.intent,
    touches: parseStringArray(r.touches),
    acceptance: r.acceptance ?? null,
    dependsOn: parseStringArray(r.depends_on),
    rejected: parseRejected(r.rejected),
  };
}

function parseRejected(raw: string | null | undefined): PlanAtomRejection[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): PlanAtomRejection[] => {
      if (typeof entry !== 'object' || entry === null) return [];
      const { route, because } = entry as Record<string, unknown>;
      if (typeof route !== 'string' || typeof because !== 'string') return [];
      return [{ route, because }];
    });
  } catch {
    return [];
  }
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

export function rowToAmendment(r: PlanAmendmentRow): PlanAmendment {
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

export function rowToCaveatAnswer(r: PlanCaveatAnswerRow): PlanCaveatAnswer {
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

export function rowToRevision(r: PlanRevisionRow): PlanRevision {
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
          atoms: Array.isArray(bag.atoms) ? parseStringArray(JSON.stringify(bag.atoms)) : undefined,
          dependsOn: parseStringArray(JSON.stringify(bag.dependsOn ?? [])),
          rationale: text('rationale'),
          acceptance: text('acceptance'),
          size: partSizeOf(text('size')),
          expectedKind: partOutcomeKindOf(text('expectedKind')),
          profile: text('profile'),
          coverage: text('coverage'),
        },
      ];
    });
  } catch {
    return [];
  }
}
