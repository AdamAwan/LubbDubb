// → docs/spec/15-integrations.md

export interface PrReplyInput {
  prNumber: number;
  commentId: string | null;
  body: string;
}

export interface PrThreadResolveInput {
  prNumber: number;
  commentId: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PrMergeInput {
  prNumber: number;
  method: MergeMethod;
}

export interface PrCloseInput {
  prNumber: number;
}

export interface PrLabelInput {
  prNumber: number;
  label: string;
  present: boolean;
}

export interface PrCreateInput {
  branch: string;
  base: string;
  title: string;
  body: string;
}

export interface PrTitleInput {
  prNumber: number;
  title: string;
}

export interface PrBaseInput {
  prNumber: number;
  base: string;
}

export interface PrBaseUpdateInput {
  prNumber: number;
  base: string;
}

export interface CiCheckRequeueInput {
  prNumber: number;
  check: string;
  requeueRef: string;
}

export interface BranchDeleteInput {
  branch: string;
}

export interface WorkItemStateInput {
  number: number;
  state: string;
}

export interface WorkItemLinkInput {
  number: number;
  prNumber: number;
}

export interface WorkItemParentInput {
  number: number;
  parentNumber: number;
}

export interface WorkItemAreaPathInput {
  number: number;
  areaPath: string;
}

export interface IssueLabelInput {
  number: number;
  label: string;
  present: boolean;
}

export interface IssueCreateInput {
  title: string;
  body: string;
  labels: string[];
  type: string | null;
  assignee: string | null;
  relatedTo: number | null;
}

export interface IssueCloseInput {
  number: number;
  reason: 'completed' | 'not_planned';
}

export interface IssueCommentInput {
  number: number;
  body: string;
  commentRef: string | null;
}

export interface FilingTarget {
  target: string;
  identity: string | null;
}

export interface SendResult {
  ok: boolean;
  ref?: string;
  commentRef?: string;
  threadRef?: string;
}

export interface ActionSink {
  postPrReply(input: PrReplyInput): Promise<SendResult>;
  canResolvePrThread(): boolean;
  resolvePrThread(input: PrThreadResolveInput): Promise<SendResult>;
  mergePr(input: PrMergeInput): Promise<SendResult>;
  canClosePr(): boolean;
  closePr(input: PrCloseInput): Promise<SendResult>;
  setPrLabel(input: PrLabelInput): Promise<SendResult>;
  setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
  canCloseIssue(): boolean;
  closeIssue(input: IssueCloseInput): Promise<SendResult>;
  canSetWorkItemState(): boolean;
  setWorkItemState(input: WorkItemStateInput): Promise<SendResult>;
  canPlaceWorkItem(): boolean;
  setWorkItemParent(input: WorkItemParentInput): Promise<SendResult>;
  setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult>;
  createIssue(input: IssueCreateInput): Promise<SendResult>;
  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult>;
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
  setPullBase(input: PrBaseInput): Promise<SendResult>;
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult>;
  deleteBranch(input: BranchDeleteInput): Promise<SendResult>;
}
