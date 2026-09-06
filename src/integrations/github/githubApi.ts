import type { MergeMethod } from '../../sink/actionSink.js';

// → docs/spec/15-integrations.md

export interface GitHubApi {
  viewerLogin(): Promise<string>;

  listOpenPulls(): Promise<GhPullSummary[]>;
  listRecentlyClosedPulls(since: string): Promise<GhClosedPull[]>;
  getPull(number: number): Promise<GhPullDetail>;
  listPullReviews(number: number): Promise<GhReview[]>;
  listPullReviewComments(number: number): Promise<GhReviewComment[]>;
  listPullReviewThreads(number: number): Promise<GhReviewThread[]>;
  resolveReviewThread(number: number, rootCommentId: number): Promise<boolean>;
  getCombinedStatus(sha: string): Promise<GhCombinedStatus>;
  listCheckRuns(sha: string): Promise<GhCheckRun[]>;
  listCheckRunAnnotations(checkRunId: number): Promise<GhAnnotation[]>;
  getJobLog(jobId: number): Promise<string>;

  listOpenIssues(label?: string): Promise<GhIssue[]>;
  listIssuesChangedSince(since: string, label?: string): Promise<GhIssue[]>;
  listIssueTimeline(number: number): Promise<GhTimelineEvent[]>;

  createPullReviewReply(number: number, inReplyTo: number, body: string): Promise<GhCommentRef>;
  createIssueComment(number: number, body: string): Promise<GhCommentRef>;
  updateIssueComment(commentId: number, body: string): Promise<GhCommentRef>;
  mergePull(number: number, method: MergeMethod): Promise<GhMergeResult>;
  closePull(number: number): Promise<void>;
  setPullLabel(number: number, label: string, present: boolean): Promise<void>;
  setIssueLabel(number: number, label: string, present: boolean): Promise<void>;
  closeIssue(number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  createIssue(input: { title: string; body: string; labels: string[]; assignee: string | null }): Promise<{
    number: number;
  }>;
  createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number }>;
  setPullTitle(number: number, title: string): Promise<void>;
  setPullBase(number: number, base: string): Promise<void>;
  updatePullBranch(number: number): Promise<void>;
  deleteBranch(branch: string): Promise<boolean>;
}

export interface GhPullSummary {
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  authorLogin: string;
  url: string;
  labels: string[];
  assigneeLogins: string[];
  updatedAt?: string;
}

export interface GhClosedPull {
  number: number;
  title: string;
  branch: string;
  baseBranch: string;
  authorLogin: string;
  url: string;
  merged: boolean;
  closedAt: string;
  mergeCommitSha: string | null;
}

export interface GhPullDetail {
  mergeable: boolean | null;
  mergeableState: string | null;
  merged: boolean;
}

export interface GhReview {
  reviewerLogin: string;
  state: string;
  submittedAt: string | null;
}

export interface GhReviewComment {
  id: number;
  authorLogin: string;
  body: string;
  inReplyToId: number | null;
  path?: string;
  line?: number | null;
}

export interface GhReviewThread {
  rootCommentId: number;
  isResolved: boolean;
}

export interface GhCombinedStatus {
  state: string;
  totalCount: number;
  statuses?: Array<{ context: string; state: string }>;
}

export interface GhCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  id?: number;
  detailsUrl?: string | null;
}

export interface GhAnnotation {
  path: string;
  startLine: number;
  level: string;
  message: string;
  title: string;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: string;
  url: string;
  isPullRequest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GhTimelineEvent {
  event: string;
  sourcePrNumber: number | null;
  label: string | null;
  actorLogin: string | null;
}

export interface GhCommentRef {
  url: string;
  id: number;
}

export interface GhMergeResult {
  sha: string;
  merged: boolean;
}
