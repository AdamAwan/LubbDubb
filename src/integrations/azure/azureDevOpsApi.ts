import type { AreaPathTree } from '../../intake/placement.js';
import type { MergeMethod } from '../../sink/actionSink.js';

// → docs/spec/15-integrations.md

export interface AzureDevOpsApi {
  viewerUniqueName(): Promise<string>;

  listActivePullRequests(): Promise<AzPull[]>;
  listRecentlyClosedPullRequests(since: string): Promise<AzClosedPull[]>;
  listPullThreads(pullRequestId: number): Promise<AzThread[]>;
  listPolicyEvaluations(pullRequestId: number): Promise<AzPolicyEvaluation[]>;
  requeuePolicyEvaluation(evaluationId: string): Promise<AzPolicyRequeue>;
  getBuildTimeline(buildId: number): Promise<AzTimelineRecord[]>;
  getBuildLog(buildId: number, logId: number): Promise<string[]>;

  listPullLabels(pullRequestId: number): Promise<string[]>;

  listOpenWorkItems(tag?: string, assignedTo?: string): Promise<AzWorkItem[]>;
  listWorkItemsChangedSince(since: string, tag?: string, assignedTo?: string): Promise<AzWorkItem[]>;
  getWorkItems(ids: number[]): Promise<AzWorkItem[]>;
  listWorkItemUpdates(id: number): Promise<AzWorkItemUpdate[]>;

  createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef>;
  setThreadStatus(pullRequestId: number, threadId: number, status: string): Promise<void>;
  createThread(pullRequestId: number, content: string): Promise<AzCommentRef>;
  completePullRequest(
    pullRequestId: number,
    lastMergeSourceCommit: string,
    method: MergeMethod,
  ): Promise<AzMergeResult>;
  abandonPullRequest(pullRequestId: number): Promise<void>;
  setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void>;

  setWorkItemState(id: number, state: string): Promise<void>;

  createWorkItemComment(id: number, text: string): Promise<AzWorkItemCommentRef>;
  updateWorkItemComment(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef>;

  linkWorkItemToPull(id: number, pullRequestId: number): Promise<void>;

  createWorkItem(input: {
    type: string;
    title: string;
    description: string;
    tags: string[];
    assignedTo: string | null;
  }): Promise<{ id: number }>;
  relateWorkItem(id: number, relatedId: number): Promise<void>;
  setWorkItemTag(id: number, tag: string, present: boolean): Promise<void>;
  listAreaPaths(): Promise<AreaPathTree>;
  setWorkItemParent(id: number, parentId: number): Promise<void>;
  setWorkItemAreaPath(id: number, areaPath: string): Promise<void>;
  createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ pullRequestId: number }>;
  setPullTitle(pullRequestId: number, title: string): Promise<void>;
  setPullBase(pullRequestId: number, base: string): Promise<void>;
  deleteBranch(branch: string): Promise<boolean>;
}

export interface AzWorkItemCommentRef {
  id: number;
}

export interface AzPull {
  pullRequestId: number;
  title: string;
  branch: string;
  baseBranch: string;
  lastMergeSourceCommit: string;
  authorUniqueName: string;
  authorDisplayName: string;
  url: string;
  isDraft: boolean;
  mergeStatus: string;
  reviewers: AzReviewer[];
}

export interface AzReviewer {
  uniqueName: string;
  vote: number;
  isRequired: boolean;
  isContainer: boolean;
}

export interface AzClosedPull {
  pullRequestId: number;
  title: string;
  branch: string;
  baseBranch: string;
  authorUniqueName: string;
  url: string;
  merged: boolean;
  closedAt: string;
  mergeCommitSha: string | null;
}

export interface AzThread {
  id: number;
  status: string | null;
  filePath?: string | null;
  line?: number | null;
  properties?: Record<string, string> | null;
  comments: AzComment[];
}

interface AzComment {
  id: number;
  authorUniqueName: string;
  content: string;
  parentCommentId: number | null;
  commentType: string;
}

export interface AzPolicyEvaluation {
  evaluationId?: string;
  typeId: string;
  displayName: string;
  displayAliases?: string[];
  typeName: string;
  buildDefinitionName?: string;
  status: string | null;
  buildId?: number;
  isExpired?: boolean;
  isBlocking: boolean;
  isEnabled: boolean;
}

export interface AzPolicyRequeue {
  status: string | null;
  isExpired?: boolean;
}

export interface AzTimelineRecord {
  type: string;
  name: string;
  result: string | null;
  logId: number | null;
  issues: AzTimelineIssue[];
}

interface AzTimelineIssue {
  type: string;
  message: string;
}

export interface AzWorkItem {
  id: number;
  title: string;
  body: string;
  state: string;
  workItemType: string;
  tags: string[];
  areaPath: string;
  relationUrls: string[];
  parentId: number | null;
  childIds: number[];
  dependsOnIds: number[];
  url: string;
  createdAt: string;
  changedAt: string;
}

export interface AzWorkItemUpdate {
  revisedByUniqueName: string;
  tagsOld?: string;
  tagsNew?: string;
}

export interface AzCommentRef {
  url: string;
  id?: number;
  threadId?: number;
}

export interface AzMergeResult {
  status: string;
}
