// → docs/spec/03-world-model.md

export type CiStatus = 'passing' | 'failing' | 'pending' | 'unknown';

export interface CiCheck {
  name: string;
  status: Exclude<CiStatus, 'unknown'>;
  blocking?: boolean;
  aliases?: string[];
  advisory?: boolean;
  expired?: boolean;
  evidenceRef?: string;
  requeueRef?: string;
}

export type MergeableState = 'dirty' | 'behind' | 'blocked' | 'clean' | 'unknown';

export type PrState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  branch: string;
  ciStatus: CiStatus;
  ciChecks?: CiCheck[];
  ciChecksWithheld?: boolean;
  unresolvedComments: PrComment[];
  reviewThreads?: PrReviewThread[];
  approved?: boolean;
  /** Who stands approving it now, and when. Absent where the provider did not read it. */
  approvals?: PrApproval[];
  mergeable?: boolean;
  baseBranch?: string;
  mergeableState?: MergeableState;
  merged?: boolean;
  state?: PrState;
  closedAt?: string;
  mergeCommitSha?: string;
  headSha?: string;
  labels?: string[];
  viewerAssignment?: ViewerAssignment;
  author?: string;
  viewerAuthored?: boolean;
  /** The author matches `botPrs.authors`: a dependency bot's, worked as the fleet's own once watched. */
  botAuthored?: boolean;
  viewerApproved?: boolean;
  /**
   * Who the tracker says is on this pull request: GitHub's assignees, Azure's individually named
   * reviewers. Absent means the provider did not say, which is never "nobody".
   */
  assignees?: PrPerson[];
  changedFiles?: number;
  url?: string;
  /** Undefined where the provider did not read it, which is not an empty body. */
  body?: string;
}

export type ViewerAssignment = 'assignee' | 'reviewer-required' | 'reviewer-optional';

export interface PrApproval {
  by: string;
  /** Absent where the provider records no time for the vote — Azure's reviewer votes. */
  at?: string;
}

/** A person as a tracker names them: `id` is what an assignment is written with, `name` what is drawn. */
export interface PrPerson {
  id: string;
  name: string;
}

export interface PrComment {
  id: string;
  author: string;
  body: string;
  handled: boolean;
  replies?: PrThreadMessage[];
}

export type PrThreadState = 'open' | 'answered' | 'resolved' | 'reopened';

export interface PrThreadMessage {
  id: string;
  author: string;
  body: string;
  ours: boolean;
}

export interface PrReviewThread {
  id: string;
  author: string;
  /**
   * The provider's own word on whether the author is a machine account. Undefined where it did not
   * say — which is not "a person", and is why `reviewBotAuthors` exists.
   */
  authorIsBot?: boolean;
  body: string;
  state: PrThreadState;
  replies: PrThreadMessage[];
  path?: string;
  line?: number;
  reopenedAt?: string;
  properties?: Readonly<Record<string, string>>;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  labels: string[];
  labelsAddedByViewer?: string[];
  state: IssueState;
  workItemState?: string;
  issueType?: string;
  areaPath?: string;
  parent?: IssueRelative | null;
  children?: IssueRelative[];
  siblings?: IssueRelative[];
  dependsOn?: IssueRelative[];
  linkedPrNumber: number | null;
  url?: string;
}

export interface IssueRelative {
  number: number;
  title: string;
  issueType: string;
  workItemState: string;
  state: IssueState;
  body?: string;
  url?: string;
}

export interface WorldSnapshot {
  takenAt: string;
  pullRequests: PullRequest[];
  closedPullRequests?: PullRequest[];
  issues: Issue[];
  staleSources?: string[];
}

export type WorldEventKind =
  | 'pr_opened'
  | 'pr_ci'
  | 'pr_approved'
  | 'pr_mergeable'
  | 'pr_merged'
  | 'pr_closed'
  | 'pr_comment'
  | 'issue_opened'
  | 'issue_closed'
  | 'issue_linked';

export interface WorldEvent {
  id: string;
  kind: WorldEventKind;
  ref: string | null;
  summary: string;
  createdAt: string;
}

export type WorldEventInput = Omit<WorldEvent, 'id' | 'createdAt'>;

export interface TrackerItem {
  number: number;
  title: string;
  labels: string[];
  state: IssueState;
  workItemState: string | null;
  url: string | null;
  createdAt: string;
  changedAt: string;
}

/** One comment on a tracker item, as a provider lists it. `id` is the provider's own, as `upsertIssueComment` answers it. */
export interface TrackerComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}
