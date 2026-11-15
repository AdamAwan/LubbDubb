import type { INVESTIGATION_RESOLUTIONS } from '../intake/investigationResolutions.js';

export interface PriorityOverride {
  origin: string;
  rank: number;
}

export interface ProfileOverride {
  origin: string;
  profile: string;
}

export interface GoalPriority {
  originRef: string;
  since: string;
}

export interface GoalPause {
  originRef: string;
  since: string;
}

export interface GoalFile {
  path: string;
  originRef: string;
  createdAt: string;
}

export interface GoalNeighbour {
  goalRef: string;
  retroSummary: string;
  sharedPaths: string[];
  lastWriteAt: string;
}

export type IssueConclusionVerdict = 'done' | 'more_work';

export type ConclusionAuthor = 'agent' | 'assessor' | 'operator';

export interface IssueConclusion {
  originRef: string;
  verdict: IssueConclusionVerdict;
  note: string;
  by: ConclusionAuthor;
  agentId: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueInstruction {
  id: string;
  originRef: string;
  text: string;
  createdAt: string;
  settledAt: string | null;
}

export type IssueRunOutcome = 'judged' | 'abandoned';

export interface IssueRun {
  originRef: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  linkedPrNumber: number | null;
  workItemState: string | null;
  startedAt: string;
  completedAt: string | null;
  outcome: IssueRunOutcome | null;
  dismissedAt: string | null;
  dismissNote: string | null;
  updatedAt: string;
}

export type DeliveryAuthor = 'assessor' | 'planner' | 'operator';

export interface IssueDelivery {
  originRef: string;
  summary: string;
  detail: string | null;
  by: DeliveryAuthor;
  agentId: string | null;
  taskId: string | null;
  decidedAt: string;
  updatedAt: string;
}

export type GoalAppraisalVerdict = 'workable' | 'unclear';

export type AppraisalAuthor = 'appraiser' | 'operator';

export interface IssueAppraisal {
  originRef: string;
  verdict: GoalAppraisalVerdict;
  summary: string;
  missing: string[];
  goalRef: string;
  by: AppraisalAuthor;
  proposedProfile: string | null;
  profileAnsweredAt: string | null;
  proposedParent: number | null;
  parentSettledAt: string | null;
  proposedAreaPath: string | null;
  areaPathSettledAt: string | null;
  agentId: string | null;
  taskId: string | null;
  commentRef: string | null;
  decidedAt: string;
  updatedAt: string;
}

export type InvestigationConfidence = 'high' | 'medium' | 'low';

export type InvestigationResolution = (typeof INVESTIGATION_RESOLUTIONS)[number];

export interface IssueInvestigation {
  originRef: string;
  goalRef: string;
  by: string;
  reproduction: string;
  rootCause: string;
  confidence: InvestigationConfidence;
  locations: string;
  blastRadius: string;
  recommendation: InvestigationResolution;
  decidedAt: string;
  resolution: InvestigationResolution | null;
  resolvedAt: string | null;
}

export interface ScratchEntry {
  id: string;
  padRef: string;
  authorOriginRef: string;
  agentId: string;
  taskId: string;
  topic: string | null;
  note: string;
  decision: PadDecision | null;
  createdAt: string;
}

export interface PadDecision {
  chose: string;
  because: string;
  rejected: { alternative: string; because: string }[];
  paths: string[];
}

export interface ScratchPadSummary {
  padRef: string;
  entries: number;
  updatedAt: string;
}

export interface Retrospective {
  originRef: string;
  summary: string;
  document: string;
  agentId: string;
  taskId: string;
  createdAt: string;
  updatedAt: string;
}

export type ShortfallCause = 'plan' | 'part' | 'goal';

export type ShortfallAuthor = 'assessor' | 'operator';

export interface IssueShortfall {
  originRef: string;
  cause: ShortfallCause | null;
  partSlug: string | null;
  summary: string;
  detail: string | null;
  by: ShortfallAuthor;
  agentId: string | null;
  taskId: string | null;
  decidedAt: string;
  updatedAt: string;
}
