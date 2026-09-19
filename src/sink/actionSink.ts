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

/**
 * A body written onto a pull request that is already open. The description is the
 * operator's and is written after they have read the pull request, so the body it
 * composes always lands as an edit — there is no open-time path for it.
 * → docs/spec/07-pull-requests.md#the-operator-writes-the-description
 */
export interface PrBodyInput {
  prNumber: number;
  body: string;
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

/**
 * One image, put where the ticket itself keeps it. `bytes` rather than a path because the sink knows
 * nothing about the harness's directories, and `fileName` because that is what the tracker names the
 * attachment — never the harness's own path to it.
 */
export interface IssueImageInput {
  number: number;
  fileName: string;
  bytes: Buffer;
}

/** Where the provider put it, which is what a comment body embeds. */
export interface IssueImageResult {
  ok: boolean;
  url: string;
}

/**
 * Uploading an image to a ticket, which **only some providers can do**. It is a capability beside
 * `ActionSink` rather than two more members on it for one reason: Azure DevOps has a documented
 * attachment API and GitHub has none — the upload endpoint its web UI uses is not in the REST API —
 * so this is permanently a thing one provider does and another does not. A caller asks
 * `canAttachIssueImage()` and has a **working** answer either way: the image where it can be had, a
 * link where it cannot.
 * → docs/spec/15-integrations.md#uploading-an-image-to-a-ticket
 */
export interface IssueImageSink {
  canAttachIssueImage(): boolean;
  attachIssueImage(input: IssueImageInput): Promise<IssueImageResult>;
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
  setPullBody(input: PrBodyInput): Promise<SendResult>;
  setPullBase(input: PrBaseInput): Promise<SendResult>;
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult>;
  deleteBranch(input: BranchDeleteInput): Promise<SendResult>;
}
