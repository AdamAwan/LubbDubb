import type { GoalWatchKind } from './watch.js';

export type PlanStatus = 'planning' | 'awaiting_approval' | 'active' | 'complete' | 'abandoned';

interface WatchIntent {
  kind: GoalWatchKind;
  source: string;
  says: string;
  why: string | null;
}

export type WatchHint = { intents: WatchIntent[] } | { none: string };

export interface Plan {
  id: string;
  originRef: string;
  title: string;
  status: PlanStatus;
  diagnosis: string | null;
  approach: string | null;
  reason: string | null;
  risks: string | null;
  outOfScope: string | null;
  alternatives: string | null;
  openQuestions: string | null;
  verification: string | null;
  evidence: PlanEvidence[];
  document: string | null;
  watchHint: WatchHint | null;
  statusCommentRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanCaveat {
  id: string;
  label: string;
  detail: string | null;
}

export interface PlanCaveatAnswer {
  id: string;
  planId: string;
  caveatId: string;
  label: string;
  answer: string;
  at: string;
}

export interface PlanNarrative {
  reason: string | null;
  diagnosis: string | null;
  approach: string | null;
  risks: string | null;
  outOfScope: string | null;
  alternatives: string | null;
  openQuestions: string | null;
  verification: string | null;
  document: string | null;
  evidence: PlanEvidence[];
}

export interface PlanRevision {
  id: string;
  planId: string;
  seq: number;
  narrative: PlanNarrative;
  parts: PlanPartInput[];
  at: string;
}

export type PlanAmendmentAuthor = 'agent' | 'operator';

export type PlanAmendmentStatus = 'pending' | 'applied' | 'declined' | 'superseded';

export interface PlanAmendment {
  id: string;
  planId: string;
  originRef: string;
  document: string;
  note: string;
  author: PlanAmendmentAuthor;
  authorRef: string | null;
  status: PlanAmendmentStatus;
  resolution: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface PlanEvidence {
  path: string;
  line: number | null;
  note: string | null;
}

export type PartSize = 's' | 'm' | 'l';

type PlanPartStatus = 'pending' | 'ready' | 'dispatched' | 'in_review' | 'merged' | 'concluded' | 'blocked' | 'retired';

export type PartOutcomeKind = 'code' | 'report' | 'determination' | 'human';

export interface PlanPart {
  id: string;
  planId: string;
  slug: string;
  seq: number;
  title: string;
  scope: string;
  touches: string[];
  atoms?: string[];
  rationale: string | null;
  acceptance: string | null;
  acceptanceMet: string[];
  size: PartSize | null;
  expectedKind: PartOutcomeKind | null;
  profile?: string | null;
  coverage?: string | null;
  outcomeKind: PartOutcomeKind | null;
  outcomeRef: string | null;
  outcomeSummary: string | null;
  dependsOn: string[];
  branch: string | null;
  prNumber: number | null;
  status: PlanPartStatus;
  blockedReason: string | null;
  blockedBy: PlanPartBlocker | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PlanPartBlocker = 'collision' | 'declined';

export interface PlanAtomRejection {
  route: string;
  because: string;
}

export interface PlanAtom {
  id: string;
  planId: string;
  slug: string;
  seq: number;
  title: string;
  intent: string;
  touches: string[];
  acceptance: string | null;
  dependsOn: string[];
  rejected: PlanAtomRejection[];
}

export type PlanAtomInput = Omit<PlanAtom, 'id' | 'planId'>;

export type PlanPartInput = Pick<
  PlanPart,
  | 'slug'
  | 'seq'
  | 'title'
  | 'scope'
  | 'touches'
  | 'atoms'
  | 'dependsOn'
  | 'rationale'
  | 'acceptance'
  | 'size'
  | 'expectedKind'
  | 'profile'
  | 'coverage'
>;
