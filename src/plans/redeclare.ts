import type { Plan, PlanPart, PlanPartInput } from '../types.js';

const KEPT_PROSE = [
  'diagnosis',
  'approach',
  'risks',
  'outOfScope',
  'alternatives',
  'openQuestions',
  'verification',
  'document',
  'statusCommentRef',
] as const;

type KeptProse = Record<(typeof KEPT_PROSE)[number], string | null>;

export function keptProse(input: Partial<KeptProse>, existing: Plan | null): KeptProse {
  const kept = {} as KeptProse;
  for (const key of KEPT_PROSE) kept[key] = input[key] ?? existing?.[key] ?? null;
  return kept;
}

type PartProgress = Pick<
  PlanPart,
  | 'acceptanceMet'
  | 'outcomeKind'
  | 'outcomeRef'
  | 'outcomeSummary'
  | 'branch'
  | 'prNumber'
  | 'status'
  | 'blockedReason'
  | 'blockedBy'
  | 'taskId'
  | 'createdAt'
>;

function carriedProgress(prev: PlanPart | undefined, ts: string): PartProgress {
  if (!prev)
    return {
      acceptanceMet: [],
      outcomeKind: null,
      outcomeRef: null,
      outcomeSummary: null,
      branch: null,
      prNumber: null,
      status: 'pending',
      blockedReason: null,
      blockedBy: null,
      taskId: null,
      createdAt: ts,
    };
  const revived = prev.status === 'retired';
  return {
    acceptanceMet: prev.acceptanceMet,
    outcomeKind: prev.outcomeKind,
    outcomeRef: prev.outcomeRef,
    outcomeSummary: prev.outcomeSummary,
    branch: prev.branch,
    prNumber: prev.prNumber,
    status: revived ? 'pending' : prev.status,
    blockedReason: revived ? null : prev.blockedReason,
    blockedBy: revived ? null : prev.blockedBy,
    taskId: prev.taskId,
    createdAt: prev.createdAt,
  };
}

export function redeclaredPart(planId: string, input: PlanPartInput, prev: PlanPart | undefined, ts: string): PlanPart {
  const carried = carriedProgress(prev, ts);
  return {
    id: `${planId}:${input.slug}`,
    planId,
    slug: input.slug,
    seq: input.seq,
    title: input.title,
    scope: input.scope,
    touches: input.touches,
    atoms: input.atoms ?? prev?.atoms,
    rationale: input.rationale,
    acceptance: input.acceptance,
    acceptanceMet: carried.acceptanceMet,
    size: input.size,
    expectedKind: input.expectedKind,
    profile: input.profile,
    coverage: input.coverage ?? null,
    outcomeKind: carried.outcomeKind,
    outcomeRef: carried.outcomeRef,
    outcomeSummary: carried.outcomeSummary,
    dependsOn: input.dependsOn,
    branch: carried.branch,
    prNumber: carried.prNumber,
    status: carried.status,
    blockedReason: carried.blockedReason,
    blockedBy: carried.blockedBy,
    taskId: carried.taskId,
    createdAt: carried.createdAt,
    updatedAt: ts,
  };
}
