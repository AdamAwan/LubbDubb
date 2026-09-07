import type { Connector, InjectableEvent } from '../connector/connector.js';
import type {
  ActionSink,
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
  WorkItemLinkInput,
  WorkItemAreaPathInput,
  WorkItemParentInput,
  WorkItemStateInput,
} from '../sink/actionSink.js';
import type { TrackerItem, WorldSnapshot } from '../types.js';
import { DEFAULT_READ_LANES, type ReadLanes, type ReadPlan } from '../world/readPlan.js';
import { signOff } from '../sink/signOff.js';
import { markdownToHtml } from '../sink/markdownToHtml.js';
import type { CiEvidenceReader, CiEvidenceTarget, CiFailureEvidence } from '../ci/ciEvidence.js';
import type { AreaPathTree } from '../intake/placement.js';
import {
  isBranchDeleteCapable,
  isCiCheckRequeueCapable,
  isCiEvidenceCapable,
  isInjectable,
  isIssueCloseCapable,
  isIssueCommentCapable,
  isIssueCreateCapable,
  isIssueLabelCapable,
  isPrBaseCapable,
  isPrBaseUpdateCapable,
  isPrCloseCapable,
  isPrCreateCapable,
  isPrLabelCapable,
  isPrMergeCapable,
  isPrReplyCapable,
  isPrThreadResolveCapable,
  isPrTitleCapable,
  isRefResolvable,
  isTicketHistoryCapable,
  isWorkItemLinkCapable,
  isAreaPathCapable,
  isWorkItemPlacementCapable,
  isWorkItemStateCapable,
  type Integration,
} from './integration.js';

// → docs/spec/15-integrations.md

export class CompositeConnector implements Connector, ActionSink, CiEvidenceReader {
  constructor(
    private readonly integrations: Integration[],
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly lanes: ReadLanes = DEFAULT_READ_LANES,
  ) {}

  async getState(plan?: ReadPlan): Promise<WorldSnapshot> {
    const read: ReadPlan = plan ?? { hot: 'all', ...this.lanes };
    const slices = await Promise.all(this.integrations.map(async (i) => ({ id: i.id, slice: await i.snapshot(read) })));
    const staleSources = slices.filter(({ slice }) => slice.stale === true).map(({ id }) => id);
    return {
      takenAt: this.now(),
      pullRequests: slices.flatMap(({ slice }) => slice.pullRequests ?? []),
      closedPullRequests: slices.flatMap(({ slice }) => slice.closedPullRequests ?? []),
      issues: slices.flatMap(({ slice }) => slice.issues ?? []),
      ...(staleSources.length > 0 ? { staleSources } : {}),
    };
  }

  async readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]> {
    const handler = this.integrations.find(isCiEvidenceCapable);
    if (!handler) return [];
    return handler.readCiFailureEvidence(prNumber, checks);
  }

  async listTicketHistory(since: string): Promise<TrackerItem[]> {
    const handler = this.integrations.find(isTicketHistoryCapable);
    if (!handler) return [];
    return handler.listTicketHistory(since);
  }

  /**
   * The project's area tree, or **null when no provider has one** — the third
   * routed read that answers rather than throwing, for {@link listTicketHistory}'s
   * reason. A tracker with no classification tree is an ordinary configuration
   * (GitHub, the fake), and the whole area-path question is then absent.
   *
   * Null rather than an empty tree, because the two are different readings and
   * only one of them is about this project: an empty tree is a project that has
   * never subdivided, and null is a tracker with no such concept at all.
   *
   * @public read structurally through `AreaPathSource` (`src/intake/areaPaths.ts`),
   * which is what `AreaPathDirectory` is handed. Name-based analysis cannot see
   * that seam.
   */
  async listAreaPaths(): Promise<AreaPathTree | null> {
    const handler = this.integrations.find(isAreaPathCapable);
    if (!handler) return null;
    return handler.listAreaPaths();
  }

  /**
   * Whether any provider can answer {@link listTicketHistory} at all.
   *
   * @public — read structurally through `TicketHistorySource` (`src/tickets/sweep.ts`),
   * which is what `TicketSweep` is handed. Name-based analysis cannot see that seam.
   */
  get tracksTicketHistory(): boolean {
    return this.integrations.some(isTicketHistoryCapable);
  }

  private signed(handler: Integration, body: string): string {
    const format = handler.bodyFormat ?? 'markdown';
    return signOff(format === 'html' ? markdownToHtml(body) : body, format);
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrReplyCapable);
    if (!handler) throw new Error('no integration can post PR replies (no sourceControl provider is PrReplyCapable)');
    return handler.postPrReply({ ...input, body: this.signed(handler, input.body) });
  }

  canResolvePrThread(): boolean {
    return this.integrations.some(isPrThreadResolveCapable);
  }

  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrThreadResolveCapable);
    if (!handler)
      throw new Error(
        'no integration can resolve review threads (no sourceControl provider is PrThreadResolveCapable)',
      );
    return handler.resolvePrThread(input);
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrMergeCapable);
    if (!handler) throw new Error('no integration can merge PRs (no sourceControl provider is PrMergeCapable)');
    return handler.mergePr(input);
  }

  canClosePr(): boolean {
    return this.integrations.some(isPrCloseCapable);
  }

  async closePr(input: PrCloseInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrCloseCapable);
    if (!handler) throw new Error('no integration can close PRs (no sourceControl provider is PrCloseCapable)');
    return handler.closePr(input);
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrLabelCapable);
    if (!handler) throw new Error('no integration can label PRs (no sourceControl provider is PrLabelCapable)');
    return handler.setPrLabel(input);
  }

  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrCreateCapable);
    if (!handler) throw new Error('no integration can open PRs (no sourceControl provider is PrCreateCapable)');
    return handler.createPullRequest({ ...input, body: this.signed(handler, input.body) });
  }

  async setPullTitle(input: PrTitleInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrTitleCapable);
    if (!handler) throw new Error('no integration can retitle PRs (no sourceControl provider is PrTitleCapable)');
    return handler.setPullTitle(input);
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrBaseCapable);
    if (!handler) throw new Error('no integration can retarget PRs (no sourceControl provider is PrBaseCapable)');
    return handler.setPullBase(input);
  }

  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrBaseUpdateCapable);
    if (!handler) return { ok: false };
    return handler.updatePrBranch(input);
  }

  async requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult> {
    const handler = this.integrations.find(isCiCheckRequeueCapable);
    if (!handler) return { ok: false };
    return handler.requeueCiCheck(input);
  }

  async deleteBranch(input: BranchDeleteInput): Promise<SendResult> {
    const handler = this.integrations.find(isBranchDeleteCapable);
    if (!handler)
      throw new Error('no integration can delete branches (no sourceControl provider is BranchDeleteCapable)');
    return handler.deleteBranch(input);
  }

  async setIssueLabel(input: IssueLabelInput): Promise<SendResult> {
    const handler = this.integrations.find(isIssueLabelCapable);
    if (!handler) throw new Error('no integration can label issues (no issues provider is IssueLabelCapable)');
    return handler.setIssueLabel(input);
  }

  async linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    const handler = this.integrations.find(isWorkItemLinkCapable);
    if (!handler) return { ok: false };
    return handler.linkWorkItem(input);
  }

  canCloseIssue(): boolean {
    return this.integrations.some(isIssueCloseCapable);
  }

  async closeIssue(input: IssueCloseInput): Promise<SendResult> {
    const handler = this.integrations.find(isIssueCloseCapable);
    if (!handler) throw new Error('no integration can close issues (no issues provider is IssueCloseCapable)');
    return handler.closeIssue(input);
  }

  canSetWorkItemState(): boolean {
    return this.integrations.some(isWorkItemStateCapable);
  }

  async setWorkItemState(input: WorkItemStateInput): Promise<SendResult> {
    const handler = this.integrations.find(isWorkItemStateCapable);
    if (!handler)
      throw new Error('no integration can set work item state (no issues provider is WorkItemStateCapable)');
    return handler.setWorkItemState(input);
  }

  canPlaceWorkItem(): boolean {
    return this.integrations.some(isWorkItemPlacementCapable);
  }

  async setWorkItemParent(input: WorkItemParentInput): Promise<SendResult> {
    const handler = this.integrations.find(isWorkItemPlacementCapable);
    if (!handler)
      throw new Error('no integration can place work items (no issues provider is WorkItemPlacementCapable)');
    return handler.setWorkItemParent(input);
  }

  async setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult> {
    const handler = this.integrations.find(isWorkItemPlacementCapable);
    if (!handler)
      throw new Error('no integration can place work items (no issues provider is WorkItemPlacementCapable)');
    return handler.setWorkItemAreaPath(input);
  }

  async createIssue(input: IssueCreateInput): Promise<SendResult> {
    const handler = this.integrations.find(isIssueCreateCapable);
    if (!handler) throw new Error('no integration can create issues (no issues provider is IssueCreateCapable)');
    return handler.createIssue({ ...input, body: this.signed(handler, input.body) });
  }

  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const handler = this.integrations.find(isIssueCommentCapable);
    if (!handler) throw new Error('no integration can comment on issues (no issues provider is IssueCommentCapable)');
    return handler.upsertIssueComment({ ...input, body: this.signed(handler, input.body) });
  }

  resolveRefUrl(ref: string): string | null {
    const resolver = this.integrations.find(isRefResolvable);
    return resolver ? resolver.resolveRefUrl(ref) : null;
  }

  inject(event: InjectableEvent): void {
    const target = this.integrations.find((i) => isInjectable(i) && i.handles(event.kind));
    if (target && isInjectable(target)) target.inject(event);
  }
}
