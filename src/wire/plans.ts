import type { QueueItem } from '../dispatcher/dispatcher.js';
import type { AcceptanceCriterion } from '../plans/parts.js';
import type { PlanDiff } from '../plans/planDiff.js';
import type {
  Plan,
  PlanAmendmentAuthor,
  PlanPart,
  PlanRevision,
  ValidationCheck,
  ValidationResource,
} from '../types.js';

/**
 * A part waiting on somebody to say what its pull request does.
 *
 * It carries the pull request's number rather than leaving the cockpit to find it on
 * the part: `plan_parts.pr_number` is a reading of the world filled in by a later
 * cycle, and the ask is raised off the record `open_pr` wrote at the open.
 * → docs/spec/07-pull-requests.md#the-rail-asks-for-it-and-nothing-waits-on-the-answer
 */
export interface UndescribedPart {
  originRef: string;
  prNumber: number;
  openedAt: string;
}

/**
 * A checked description that found something, as the rail raises it. `contradicted`
 * is the count that asks for a change; a version with only `gaps` is a low-priority
 * note. → docs/spec/07-pull-requests.md#what-the-check-raises
 */
export interface DescriptionFeedback {
  originRef: string;
  prNumber: number;
  versionId: string;
  checkedAt: string;
  contradicted: number;
  gaps: number;
}

export interface PlanPartView extends PlanPart {
  depth: number;
  acceptanceCriteria: AcceptanceCriterion[];
  outsideScope: string[];
}

/** A plan as the cockpit is sent it. → docs/spec/16-http-api.md */
export type PlanView = Plan;

export interface ValidationResourceView extends ValidationResource {
  path: string;
  present: boolean;
}

/**
 * A check, plus where its capture can actually be looked at. The row carries the capture's **name**;
 * a surface needs a URL, and minting one is the server's job — a cockpit that assembled the path
 * itself would be a second opinion about where the goal's validation directory is.
 * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
 */
export interface ValidationCheckView extends ValidationCheck {
  captureUrl: string | null;
}

export interface PlanHistory {
  revisions: PlanRevision[];
  diff: PlanDiff | null;
  pending: PendingPlanAmendment | null;
}

export interface PendingPlanAmendment {
  id: string;
  note: string;
  author: PlanAmendmentAuthor;
  createdAt: string;
  diff: PlanDiff | null;
  warnings: string[];
}

export interface UpcomingPlan {
  cycleId: string;
  at: string;
  items: QueueItem[];
}
