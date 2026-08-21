import type { Connector, InjectableEvent } from './connector.js';
import type {
  ActionSink,
  BranchDeleteInput,
  CiCheckRequeueInput,
  IssueCommentInput,
  IssueCreateInput,
  IssueLabelInput,
  PrBaseInput,
  PrBaseUpdateInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrTitleInput,
  SendResult,
  WorkItemLinkInput,
  WorkItemStateInput,
} from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { CompositeConnector } from '../integrations/compositeConnector.js';
import { FakeWorldStore } from '../integrations/fake/fakeWorld.js';
import { FakeGitHubIntegration } from '../integrations/fake/fakeGitHub.js';
import { FakeIssuesIntegration } from '../integrations/fake/fakeIssues.js';

/**
 * A convenience bundle: the fake integrations (source control, issues)
 * sharing one persisted world, composed behind {@link Connector} +
 * {@link ActionSink}. Equivalent to selecting the `fake` provider for every
 * capability — this is what makes the harness behave identically to before the
 * integrations were modularised, and gives tests a one-call fake with the
 * inject/reflect helpers.
 *
 * Production wiring builds the composite from config via `buildIntegrations`
 * (see `system.ts`); this facade is the same modules assembled directly.
 */
export class FakeConnector implements Connector, ActionSink {
  private readonly composite: CompositeConnector;
  private readonly github: FakeGitHubIntegration;
  private readonly issues: FakeIssuesIntegration;

  constructor(store: Store, now: () => string = () => new Date().toISOString()) {
    const world = new FakeWorldStore(store);
    this.github = new FakeGitHubIntegration(world);
    this.issues = new FakeIssuesIntegration(world);
    this.composite = new CompositeConnector([this.github, this.issues], now);
  }

  getState(): Promise<WorldSnapshot> {
    return this.composite.getState();
  }

  postPrReply(input: PrReplyInput): Promise<SendResult> {
    return this.composite.postPrReply(input);
  }

  mergePr(input: PrMergeInput): Promise<SendResult> {
    return this.composite.mergePr(input);
  }

  setPrLabel(input: PrLabelInput): Promise<SendResult> {
    return this.composite.setPrLabel(input);
  }

  setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    return this.composite.setIssueLabel(input);
  }

  canSetWorkItemState(): boolean {
    return this.composite.canSetWorkItemState();
  }

  setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    return this.composite.setWorkItemState(input);
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

  createPullRequest(input: PrCreateInput): Promise<SendResult> {
    return this.composite.createPullRequest(input);
  }

  setPullTitle(input: PrTitleInput): Promise<SendResult> {
    return this.composite.setPullTitle(input);
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

  /** Apply an event to the fake world (routes to the owning module) and log it. */
  inject(event: InjectableEvent): void {
    this.composite.inject(event);
  }

  markIssueLinked(issueNumber: number, prNumber: number): void {
    this.issues.markIssueLinked(issueNumber, prNumber);
  }
}
