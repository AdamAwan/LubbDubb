import type { Connector, InjectableEvent } from '../connector.js';
import type { ReadPlan } from '../../world/readPlan.js';
import type {
  ActionSink,
  BranchDeleteInput,
  CiCheckRequeueInput,
  IssueCommentInput,
  IssueImageInput,
  IssueImageResult,
  IssueImageSink,
  IssueCreateInput,
  IssueCloseInput,
  IssueLabelInput,
  PrBaseInput,
  PrBodyInput,
  PrBaseUpdateInput,
  PrCloseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
  WorkItemLinkInput,
  WorkItemAreaPathInput,
  WorkItemParentInput,
  WorkItemStateInput,
} from '../../sink/actionSink.js';
import type { Store } from '../../store/store.js';
import type { WorldSnapshot } from '../../types.js';
import { CompositeConnector } from '../compositeConnector.js';
import { FakeWorldStore } from './fakeWorld.js';
import { FakeGitHubIntegration } from './fakeGitHub.js';
import { FakeIssuesIntegration } from './fakeIssues.js';

// → docs/spec/03-world-model.md

export class FakeConnector implements Connector, ActionSink, IssueImageSink {
  private readonly composite: CompositeConnector;
  private readonly github: FakeGitHubIntegration;
  private readonly issues: FakeIssuesIntegration;

  constructor(store: Store, now: () => string = () => new Date().toISOString()) {
    const world = new FakeWorldStore(store);
    this.github = new FakeGitHubIntegration(world);
    this.issues = new FakeIssuesIntegration(world);
    this.composite = new CompositeConnector([this.github, this.issues], now);
  }

  getState(plan?: ReadPlan): Promise<WorldSnapshot> {
    return this.composite.getState(plan);
  }

  postPrReply(input: PrReplyInput): Promise<SendResult> {
    return this.composite.postPrReply(input);
  }

  canResolvePrThread(): boolean {
    return this.composite.canResolvePrThread();
  }

  resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    return this.composite.resolvePrThread(input);
  }

  mergePr(input: PrMergeInput): Promise<SendResult> {
    return this.composite.mergePr(input);
  }

  canClosePr(): boolean {
    return this.composite.canClosePr();
  }

  closePr(input: PrCloseInput): Promise<SendResult> {
    return this.composite.closePr(input);
  }

  setPrLabel(input: PrLabelInput): Promise<SendResult> {
    return this.composite.setPrLabel(input);
  }

  setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    return this.composite.setIssueLabel(input);
  }

  canCloseIssue(): boolean {
    return this.composite.canCloseIssue();
  }

  closeIssue(input: IssueCloseInput): Promise<SendResult> {
    return this.composite.closeIssue(input);
  }

  canSetWorkItemState(): boolean {
    return this.composite.canSetWorkItemState();
  }

  setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    return this.composite.setWorkItemState(input);
  }

  canPlaceWorkItem(): boolean {
    return this.composite.canPlaceWorkItem();
  }

  setWorkItemParent(input: WorkItemParentInput): Promise<SendResult> {
    return this.composite.setWorkItemParent(input);
  }

  setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult> {
    return this.composite.setWorkItemAreaPath(input);
  }

  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    return this.composite.linkWorkItem(input);
  }

  createIssue(input: IssueCreateInput): Promise<SendResult> {
    return this.composite.createIssue(input);
  }
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    return this.composite.upsertIssueComment(input);
  }

  canAttachIssueImage(): boolean {
    return this.composite.canAttachIssueImage();
  }

  attachIssueImage(input: IssueImageInput): Promise<IssueImageResult> {
    return this.composite.attachIssueImage(input);
  }

  createPullRequest(input: PrCreateInput): Promise<SendResult> {
    return this.composite.createPullRequest(input);
  }

  setPullTitle(input: PrTitleInput): Promise<SendResult> {
    return this.composite.setPullTitle(input);
  }

  setPullBody(input: PrBodyInput): Promise<SendResult> {
    return this.composite.setPullBody(input);
  }

  /** @public the seam a test asserts a pushed description through */
  pullBody(prNumber: number): string | null {
    return this.github.pullBody(prNumber);
  }

  setPullBase(input: PrBaseInput): Promise<SendResult> {
    return this.composite.setPullBase(input);
  }

  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    return this.composite.updatePrBranch(input);
  }

  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult> {
    return this.composite.requeueCiCheck(input);
  }

  deleteBranch(input: BranchDeleteInput): Promise<SendResult> {
    return this.composite.deleteBranch(input);
  }

  inject(event: InjectableEvent): void {
    this.composite.inject(event);
  }

  markIssueLinked(issueNumber: number, prNumber: number): void {
    this.issues.markIssueLinked(issueNumber, prNumber);
  }
}
