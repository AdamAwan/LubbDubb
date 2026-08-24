import type { Connector, InjectableEvent } from '../connector/connector.js';
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
  WorkItemAreaPathInput,
  WorkItemParentInput,
  WorkItemStateInput,
} from '../sink/actionSink.js';
import type { TrackerItem, WorldSnapshot } from '../types.js';
import type { CiEvidenceReader, CiEvidenceTarget, CiFailureEvidence } from '../ci/ciEvidence.js';
import type { AreaPathTree } from '../intake/placement.js';
import {
  isBranchDeleteCapable,
  isCiCheckRequeueCapable,
  isCiEvidenceCapable,
  isInjectable,
  isIssueCommentCapable,
  isIssueCreateCapable,
  isIssueLabelCapable,
  isPrBaseCapable,
  isPrBaseUpdateCapable,
  isPrCreateCapable,
  isPrLabelCapable,
  isPrMergeCapable,
  isPrReplyCapable,
  isPrTitleCapable,
  isRefResolvable,
  isTicketHistoryCapable,
  isWorkItemLinkCapable,
  isAreaPathCapable,
  isWorkItemPlacementCapable,
  isWorkItemStateCapable,
  type Integration,
} from './integration.js';

/**
 * Assembles the world from many {@link Integration}s and presents it behind the
 * single {@link Connector} + {@link ActionSink} seams the harness and executor
 * depend on — so neither of them changes when providers are swapped or added.
 *
 * - Reads: fan out `snapshot()` across integrations and merge the slices.
 * - Outbound: route each side-effectful action to the integration that can
 *   handle it (by capability), not to a hard-coded provider.
 * - Inject (fake-only): route an injected event to the fake that owns its kind.
 */
export class CompositeConnector implements Connector, ActionSink, CiEvidenceReader {
  constructor(
    private readonly integrations: Integration[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async getState(): Promise<WorldSnapshot> {
    const slices = await Promise.all(this.integrations.map(async (i) => ({ id: i.id, slice: await i.snapshot() })));
    // Named per integration rather than counted, because which half of the world
    // is old changes what a decision made against it is worth: a stale issue list
    // with fresh pull requests is a fleet that will not pick up new work, and the
    // reverse is one that may act on a pull request that has since merged.
    const staleSources = slices.filter(({ slice }) => slice.stale === true).map(({ id }) => id);
    return {
      takenAt: this.now(),
      pullRequests: slices.flatMap(({ slice }) => slice.pullRequests ?? []),
      closedPullRequests: slices.flatMap(({ slice }) => slice.closedPullRequests ?? []),
      issues: slices.flatMap(({ slice }) => slice.issues ?? []),
      ...(staleSources.length > 0 ? { staleSources } : {}),
    };
  }

  /**
   * The failing output of these checks, or `[]`.
   *
   * **The one routed method that answers rather than throwing when nothing can
   * handle it.** Every outbound method below throws, and rightly: an act the
   * operator asked for that no provider can perform is a fault worth surfacing.
   * This is the opposite — it enriches a dispatch that is going out regardless,
   * so "no provider has logs" is an ordinary answer, and raising it would turn a
   * missing nicety into a failed dispatch on the `fake` provider and on every
   * deployment whose checks are all third-party statuses.
   */
  async readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]> {
    const handler = this.integrations.find(isCiEvidenceCapable);
    if (!handler) return [];
    return handler.readCiFailureEvidence(prNumber, checks);
  }

  /**
   * Tracker items in any state changed since `since`, or `[]` when no provider can
   * answer — the second routed read that answers rather than throwing, for the
   * evidence reader's reason. A history nobody can supply is an empty tab, not a
   * failed pulse: the `fake` provider has no such list, and the sweep runs every
   * cycle.
   */
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

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrReplyCapable);
    if (!handler) throw new Error('no integration can post PR replies (no sourceControl provider is PrReplyCapable)');
    return handler.postPrReply(input);
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrMergeCapable);
    if (!handler) throw new Error('no integration can merge PRs (no sourceControl provider is PrMergeCapable)');
    return handler.mergePr(input);
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrLabelCapable);
    if (!handler) throw new Error('no integration can label PRs (no sourceControl provider is PrLabelCapable)');
    return handler.setPrLabel(input);
  }

  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrCreateCapable);
    if (!handler) throw new Error('no integration can open PRs (no sourceControl provider is PrCreateCapable)');
    return handler.createPullRequest(input);
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

  /**
   * The one outbound act whose missing handler is **not** an error (issue #332).
   *
   * Every other method here throws when no integration can serve it, because
   * nothing else can: the harness asked for the only way that act happens. This
   * one has a second way — the code agent the rule dispatched before the
   * server-side path existed — so a provider without an "update branch" endpoint
   * (Azure DevOps) is a configuration, not a fault, and saying so as `ok: false`
   * is what keeps its Errors panel clean while the fallback does the work.
   */
  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    const handler = this.integrations.find(isPrBaseUpdateCapable);
    if (!handler) return { ok: false };
    return handler.updatePrBranch(input);
  }

  /**
   * The third routed act whose missing handler is not an error, for
   * {@link updatePrBranch}'s reason exactly: rule `pr-ci-gate` dispatched a code
   * agent for this gate before the direct write existed and still does when the
   * write is unavailable, so a provider without the operation (GitHub, which has
   * no expired-policy state to begin with) is a configuration rather than a fault.
   */
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

  /**
   * The second outbound act whose missing handler is not an error, for
   * {@link updatePrBranch}'s reason: a provider that links an issue to a pull
   * request from the body text (GitHub) needs no relation written, so nothing there
   * implements this and `ok: false` means "already done", not "failed".
   */
  async linkWorkItem(input: WorkItemLinkInput): Promise<SendResult> {
    const handler = this.integrations.find(isWorkItemLinkCapable);
    if (!handler) return { ok: false };
    return handler.linkWorkItem(input);
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
    return handler.createIssue(input);
  }

  async upsertIssueComment(input: IssueCommentInput): Promise<SendResult> {
    const handler = this.integrations.find(isIssueCommentCapable);
    if (!handler) throw new Error('no integration can comment on issues (no issues provider is IssueCommentCapable)');
    return handler.upsertIssueComment(input);
  }

  /**
   * Resolve a ref to a web URL via the first integration that can, or `null` when
   * none can (e.g. an all-fake world with no real repo behind it). Used by the
   * server to build the cockpit's link map without any provider-specific logic.
   */
  resolveRefUrl(ref: string): string | null {
    const resolver = this.integrations.find(isRefResolvable);
    return resolver ? resolver.resolveRefUrl(ref) : null;
  }

  /**
   * Apply an injected event to whichever fake integration owns its kind. An event
   * with no fake owner (e.g. its domain is served by a real adapter that reads from
   * the network) is dropped rather than throwing — you cannot fake-inject onto a
   * real provider.
   */
  inject(event: InjectableEvent): void {
    const target = this.integrations.find((i) => isInjectable(i) && i.handles(event.kind));
    if (target && isInjectable(target)) target.inject(event);
  }
}
