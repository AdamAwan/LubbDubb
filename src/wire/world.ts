import type { CiVerdict } from '../ci/ciPolicy.js';
import type { IssuePickupStatus } from '../dispatcher/issuePickup.js';
import type { InvestigationStanding } from '../intake/investigation.js';
import type { PlacementAsk } from '../intake/placement.js';
import type { PrAttention } from '../pr/prAttention.js';
import type { PrHealth } from '../pr/prHealth.js';
import type { PrReviewState } from '../review/prReviewState.js';
import type {
  AppraisalAuthor,
  ConclusionAuthor,
  DeliveryAuthor,
  GoalAppraisalVerdict,
  IssueConclusionVerdict,
  IssueInstruction,
  IssueInvestigation,
  IssueRelative,
  IssueRunOutcome,
  IssueSpend,
  IssueState,
  PrPerson,
  PrSplitVerdict,
  ShortfallAuthor,
  ShortfallCause,
  ValidationVerdict,
  Issue as WorldIssue,
  PullRequest as WorldPullRequest,
  WorldSnapshot,
} from '../types.js';
import type { LocalValidationView } from './localRuns.js';

export interface PullRequest extends WorldPullRequest {
  health?: PrHealth;
  attention?: PrAttention;
  ciVerdict?: CiVerdict;
  review?: PrReviewState;
  split?: PrSplitVerdict;
}

export interface OpenPullRequest extends PullRequest {
  health: PrHealth;
  attention: PrAttention;
  ciVerdict: CiVerdict;
  /**
   * The people to offer when the fleet's own pull request is ready for somebody to look at — set
   * only while that ask stands. → docs/spec/07-pull-requests.md#asking-who-should-look-at-it
   */
  assignAsk?: PrPerson[];
}

export interface Issue extends WorldIssue {
  pickup: IssuePickupStatus;
  stale?: {
    lastSeenAt: string;
    tracker: { state: IssueState; workItemState: string | null; changedAt: string } | null;
  };
  conclusion: {
    verdict: IssueConclusionVerdict | 'undeclared';
    by: ConclusionAuthor | 'plan' | null;
    note: string;
    at: string | null;
  };
  shortfall: {
    cause: ShortfallCause | null;
    partSlug: string | null;
    summary: string;
    by: ShortfallAuthor;
    decidedAt: string;
  } | null;
  delivery: {
    summary: string;
    by: DeliveryAuthor;
    decidedAt: string;
  } | null;
  appraisal: {
    verdict: GoalAppraisalVerdict;
    summary: string;
    missing: string[];
    by: AppraisalAuthor;
    decidedAt: string;
    commentRef: string | null;
    proposedProfile: string | null;
    awaitingProfileAnswer: boolean;
    placement: PlacementAsk[];
    parentSettledAt: string | null;
    /** Still on the project root and not declined — whether or not the appraisal proposed a path. */
    areaPathUnset: boolean;
  } | null;
  investigation: IssueInvestigation | null;
  /** Why the findings hold plan and pickup, or null — read here, never off `pickup.status`, which a higher-ranked status hides. */
  investigationHold: InvestigationStanding['hold'];
  modelPin: { profile: string | null; ignoredTags: string[] };
  priority: { since: string } | null;
  retrospective: { summary: string; hasDocument: boolean; updatedAt: string } | null;
  scratchpad: { entries: number; updatedAt: string } | null;
  instructions: IssueInstruction[];
  run?: { startedAt: string; completedAt: string | null; outcome: IssueRunOutcome | null; dismissed: boolean };
  validation: ValidationVerdict | null;
  localValidation: LocalValidationView | null;
  spend: IssueSpend | null;
}

export interface CockpitWorld extends WorldSnapshot {
  pullRequests: OpenPullRequest[];
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  parentCandidates: IssueRelative[];
}
