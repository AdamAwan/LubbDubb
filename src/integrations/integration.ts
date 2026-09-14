import type { Config } from '../config/config.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { InjectableEvent } from '../connector/connector.js';
import type {
  BranchDeleteInput,
  CiCheckRequeueInput,
  IssueCloseInput,
  IssueCommentInput,
  IssueCreateInput,
  IssueLabelInput,
  PrBaseInput,
  PrBaseUpdateInput,
  PrCloseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
  WorkItemAreaPathInput,
  WorkItemLinkInput,
  WorkItemParentInput,
  WorkItemStateInput,
} from '../sink/actionSink.js';
import type { BodyFormat } from '../sink/signOff.js';
import type { CiEvidenceTarget, CiFailureEvidence } from '../ci/ciEvidence.js';
import type { AreaPathTree } from '../intake/placement.js';
import type { TrackerItem, WorldSnapshot } from '../types.js';
import type { ReadPlan } from '../world/readPlan.js';

// → docs/spec/15-integrations.md

export type WorldCapability = 'sourceControl' | 'issues';

type Capability = WorldCapability | 'pool';

export type IntegrationSelection = Record<Capability, string>;

export type WorldSlice = Partial<Pick<WorldSnapshot, 'pullRequests' | 'closedPullRequests' | 'issues'>> & {
  stale?: boolean;
};

export interface IntegrationContext {
  store: Store;
  config: Config;
  now: () => string;
  errors?: ErrorRecorder;
}

export interface Integration {
  readonly id: string;
  readonly capability: WorldCapability;
  snapshot(plan?: ReadPlan): Promise<WorldSlice>;
  readonly bodyFormat?: BodyFormat;
}

export interface PrReplyCapable {
  postPrReply(input: PrReplyInput): Promise<SendResult>;
}

export function isPrReplyCapable(x: Integration): x is Integration & PrReplyCapable {
  return typeof (x as Partial<PrReplyCapable>).postPrReply === 'function';
}

export interface PrThreadResolveCapable {
  resolvePrThread(input: PrThreadResolveInput): Promise<SendResult>;
}

export function isPrThreadResolveCapable(x: Integration): x is Integration & PrThreadResolveCapable {
  return typeof (x as Partial<PrThreadResolveCapable>).resolvePrThread === 'function';
}

export interface PrMergeCapable {
  mergePr(input: PrMergeInput): Promise<SendResult>;
}

export function isPrMergeCapable(x: Integration): x is Integration & PrMergeCapable {
  return typeof (x as Partial<PrMergeCapable>).mergePr === 'function';
}

export interface PrCloseCapable {
  closePr(input: PrCloseInput): Promise<SendResult>;
}

export function isPrCloseCapable(x: Integration): x is Integration & PrCloseCapable {
  return typeof (x as Partial<PrCloseCapable>).closePr === 'function';
}

export interface RefResolvable {
  resolveRefUrl(ref: string): string | null;
}

export function isRefResolvable(x: Integration): x is Integration & RefResolvable {
  return typeof (x as Partial<RefResolvable>).resolveRefUrl === 'function';
}

export interface PrLabelCapable {
  setPrLabel(input: PrLabelInput): Promise<SendResult>;
}

export function isPrLabelCapable(x: Integration): x is Integration & PrLabelCapable {
  return typeof (x as Partial<PrLabelCapable>).setPrLabel === 'function';
}

export interface PrCreateCapable {
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
}

export function isPrCreateCapable(x: Integration): x is Integration & PrCreateCapable {
  return typeof (x as Partial<PrCreateCapable>).createPullRequest === 'function';
}

export interface PrTitleCapable {
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
}

export function isPrTitleCapable(x: Integration): x is Integration & PrTitleCapable {
  return typeof (x as Partial<PrTitleCapable>).setPullTitle === 'function';
}

export interface PrBaseCapable {
  setPullBase(input: PrBaseInput): Promise<SendResult>;
}

export function isPrBaseCapable(x: Integration): x is Integration & PrBaseCapable {
  return typeof (x as Partial<PrBaseCapable>).setPullBase === 'function';
}

export interface PrBaseUpdateCapable {
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
}

export function isPrBaseUpdateCapable(x: Integration): x is Integration & PrBaseUpdateCapable {
  return typeof (x as Partial<PrBaseUpdateCapable>).updatePrBranch === 'function';
}

export interface CiCheckRequeueCapable {
  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult>;
}

export function isCiCheckRequeueCapable(x: Integration): x is Integration & CiCheckRequeueCapable {
  return typeof (x as Partial<CiCheckRequeueCapable>).requeueCiCheck === 'function';
}

export interface BranchDeleteCapable {
  deleteBranch(input: BranchDeleteInput): Promise<SendResult>;
}

export function isBranchDeleteCapable(x: Integration): x is Integration & BranchDeleteCapable {
  return typeof (x as Partial<BranchDeleteCapable>).deleteBranch === 'function';
}

export interface CiEvidenceCapable {
  readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]>;
}

export function isCiEvidenceCapable(x: Integration): x is Integration & CiEvidenceCapable {
  return typeof (x as Partial<CiEvidenceCapable>).readCiFailureEvidence === 'function';
}

export interface TicketHistoryCapable {
  listTicketHistory(since: string): Promise<TrackerItem[]>;
}

export function isTicketHistoryCapable(x: Integration): x is Integration & TicketHistoryCapable {
  return typeof (x as Partial<TicketHistoryCapable>).listTicketHistory === 'function';
}

export interface AreaPathCapable {
  listAreaPaths(): Promise<AreaPathTree>;
}

export function isAreaPathCapable(x: Integration): x is Integration & AreaPathCapable {
  return typeof (x as Partial<AreaPathCapable>).listAreaPaths === 'function';
}

export interface IssueLabelCapable {
  setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
}

export function isIssueLabelCapable(x: Integration): x is Integration & IssueLabelCapable {
  return typeof (x as Partial<IssueLabelCapable>).setIssueLabel === 'function';
}

export interface IssueCloseCapable {
  closeIssue(input: IssueCloseInput): Promise<SendResult>;
}

export function isIssueCloseCapable(x: Integration): x is Integration & IssueCloseCapable {
  return typeof (x as Partial<IssueCloseCapable>).closeIssue === 'function';
}

export interface WorkItemStateCapable {
  setWorkItemState(input: WorkItemStateInput): Promise<SendResult>;
}

export function isWorkItemStateCapable(x: Integration): x is Integration & WorkItemStateCapable {
  return typeof (x as Partial<WorkItemStateCapable>).setWorkItemState === 'function';
}

export interface WorkItemPlacementCapable {
  setWorkItemParent(input: WorkItemParentInput): Promise<SendResult>;
  setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
}

export function isWorkItemPlacementCapable(x: Integration): x is Integration & WorkItemPlacementCapable {
  return typeof (x as Partial<WorkItemPlacementCapable>).setWorkItemParent === 'function';
}

export interface WorkItemLinkCapable {
  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult>;
}

export function isWorkItemLinkCapable(x: Integration): x is Integration & WorkItemLinkCapable {
  return typeof (x as Partial<WorkItemLinkCapable>).linkWorkItem === 'function';
}

export interface IssueCreateCapable {
  createIssue(input: IssueCreateInput): Promise<SendResult>;
}

export function isIssueCreateCapable(x: Integration): x is Integration & IssueCreateCapable {
  return typeof (x as Partial<IssueCreateCapable>).createIssue === 'function';
}

export interface IssueCommentCapable {
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult>;
}

export function isIssueCommentCapable(x: Integration): x is Integration & IssueCommentCapable {
  return typeof (x as Partial<IssueCommentCapable>).upsertIssueComment === 'function';
}

export interface Injectable {
  handles(kind: InjectableEvent['kind']): boolean;
  inject(event: InjectableEvent): void;
}

export function isInjectable(x: Integration): x is Integration & Injectable {
  const maybe = x as Partial<Injectable>;
  return typeof maybe.handles === 'function' && typeof maybe.inject === 'function';
}
