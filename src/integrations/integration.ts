import type { Config } from '../config.js';
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

/** A modular integration owns exactly one *slice* of the outside world. */

/** The kinds of integration that read a slice of the world. */
export type WorldCapability = 'sourceControl' | 'issues';

/**
 * Every capability a provider may fulfil. →
 * `docs/spec/28-cross-fleet-pool.md#the-transport`
 */
type Capability = WorldCapability | 'pool';

/** One provider chosen per capability. */
export type IntegrationSelection = Record<Capability, string>;

/**
 * One integration's contribution to the world — only the domains it owns. Optional, so a
 * provider that cannot fail this way says nothing.
 */
export type WorldSlice = Partial<Pick<WorldSnapshot, 'pullRequests' | 'closedPullRequests' | 'issues'>> & {
  stale?: boolean;
};

/** Everything a provider factory needs to build an integration. */
export interface IntegrationContext {
  store: Store;
  config: Config;
  /** Injectable clock so tests stay deterministic. */
  now: () => string;
  /** Central error sink: snapshot/outage failures are recorded here, not swallowed. */
  errors?: ErrorRecorder;
}

/** The base seam: every integration reads some slice of the world. */
export interface Integration {
  /** Stable id, e.g. `sourceControl:fake`. For the audit log and diagnostics. */
  readonly id: string;
  /** Which capability this integration fulfils. */
  readonly capability: WorldCapability;
  /**
   * This integration's slice of the world right now. `plan` is a **cost** hint and never a
   * filter — every entity the provider lists is in the slice either way. →
   * [04](../../docs/spec/04-harness-cycle.md#hot-and-cold)
   */
  snapshot(plan?: ReadPlan): Promise<WorldSlice>;
  /**
   * How this provider renders the prose the harness sends it — what {@link signOff} needs
   * to append a sign-off that renders rather than showing a reader its own markup.
   */
  readonly bodyFormat?: BodyFormat;
}

// ---------------------------------------------------------------------------
// Outbound capability interfaces
//
// Outbound is *not* one fat interface: a provider implements only the outbound
// capabilities it supports, and the composite routes each action to whichever
// integration can handle it. New outbound actions add a new capability interface
// here without widening a shared one.
// ---------------------------------------------------------------------------

/** An integration that can post a reply on a pull request. */
export interface PrReplyCapable {
  postPrReply(input: PrReplyInput): Promise<SendResult>;
}

export function isPrReplyCapable(x: Integration): x is Integration & PrReplyCapable {
  return typeof (x as Partial<PrReplyCapable>).postPrReply === 'function';
}

/**
 * An integration that can mark a review thread resolved. A provider that cannot resolve
 * refuses the act rather than silently dropping it.
 */
export interface PrThreadResolveCapable {
  resolvePrThread(input: PrThreadResolveInput): Promise<SendResult>;
}

export function isPrThreadResolveCapable(x: Integration): x is Integration & PrThreadResolveCapable {
  return typeof (x as Partial<PrThreadResolveCapable>).resolvePrThread === 'function';
}

/** An integration that can merge a pull request — the outbound side of PR monitoring. */
export interface PrMergeCapable {
  mergePr(input: PrMergeInput): Promise<SendResult>;
}

export function isPrMergeCapable(x: Integration): x is Integration & PrMergeCapable {
  return typeof (x as Partial<PrMergeCapable>).mergePr === 'function';
}

/**
 * An integration that can **close** a pull request without merging it — the plan part
 * restart's superseded PR ([08](../../docs/spec/08-planning.md#restarting-a-part)).
 */
export interface PrCloseCapable {
  closePr(input: PrCloseInput): Promise<SendResult>;
}

export function isPrCloseCapable(x: Integration): x is Integration & PrCloseCapable {
  return typeof (x as Partial<PrCloseCapable>).closePr === 'function';
}

/**
 * An integration that can turn a harness reference into a canonical web URL — the seam that
 * keeps URL construction in the provider (which knows the repo identity) rather than the
 * provider-agnostic cockpit.
 */
export interface RefResolvable {
  resolveRefUrl(ref: string): string | null;
}

export function isRefResolvable(x: Integration): x is Integration & RefResolvable {
  return typeof (x as Partial<RefResolvable>).resolveRefUrl === 'function';
}

/** An integration that can add/remove a label on a pull request — the exclusion-tag toggle. */
export interface PrLabelCapable {
  setPrLabel(input: PrLabelInput): Promise<SendResult>;
}

export function isPrLabelCapable(x: Integration): x is Integration & PrLabelCapable {
  return typeof (x as Partial<PrLabelCapable>).setPrLabel === 'function';
}

/** An integration that can open a pull request — the harness authoring its own. */
export interface PrCreateCapable {
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
}

export function isPrCreateCapable(x: Integration): x is Integration & PrCreateCapable {
  return typeof (x as Partial<PrCreateCapable>).createPullRequest === 'function';
}

/** An integration that can rewrite a pull request's title — the naming convention. */
export interface PrTitleCapable {
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
}

export function isPrTitleCapable(x: Integration): x is Integration & PrTitleCapable {
  return typeof (x as Partial<PrTitleCapable>).setPullTitle === 'function';
}

/** An integration that can retarget a pull request's base — a rung whose parent merged. */
export interface PrBaseCapable {
  setPullBase(input: PrBaseInput): Promise<SendResult>;
}

export function isPrBaseCapable(x: Integration): x is Integration & PrBaseCapable {
  return typeof (x as Partial<PrBaseCapable>).setPullBase === 'function';
}

/**
 * An integration that can bring a pull request up to date with its base server-side — the
 * provider's own "update branch".
 */
export interface PrBaseUpdateCapable {
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
}

export function isPrBaseUpdateCapable(x: Integration): x is Integration & PrBaseUpdateCapable {
  return typeof (x as Partial<PrBaseUpdateCapable>).updatePrBranch === 'function';
}

/** An integration that can **queue a fresh run of an expired CI check**. */
export interface CiCheckRequeueCapable {
  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult>;
}

export function isCiCheckRequeueCapable(x: Integration): x is Integration & CiCheckRequeueCapable {
  return typeof (x as Partial<CiCheckRequeueCapable>).requeueCiCheck === 'function';
}

/** An integration that can delete a branch — the reap after a pull request merges. */
export interface BranchDeleteCapable {
  deleteBranch(input: BranchDeleteInput): Promise<SendResult>;
}

export function isBranchDeleteCapable(x: Integration): x is Integration & BranchDeleteCapable {
  return typeof (x as Partial<BranchDeleteCapable>).deleteBranch === 'function';
}

/**
 * An integration that can fetch the **failing output** of a red CI check, so a CI-fix
 * dispatch carries the assertion rather than only the check's name. →
 * [`src/ci/ciEvidence.ts`]
 */
export interface CiEvidenceCapable {
  readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]>;
}

export function isCiEvidenceCapable(x: Integration): x is Integration & CiEvidenceCapable {
  return typeof (x as Partial<CiEvidenceCapable>).readCiFailureEvidence === 'function';
}

/**
 * An integration that can list the tracker items it owns **across states** — what the
 * ticket mirror is filled from.
 */
export interface TicketHistoryCapable {
  /** Items in any state that the tracker last saw change at or after `since`. */
  listTicketHistory(since: string): Promise<TrackerItem[]>;
}

export function isTicketHistoryCapable(x: Integration): x is Integration & TicketHistoryCapable {
  return typeof (x as Partial<TicketHistoryCapable>).listTicketHistory === 'function';
}

/**
 * An integration whose tracker classifies items into a **tree** — the area paths an item
 * can be filed under. A provider with no such tree is not capable, and the area-path
 * question is then absent rather than wrong.
 */
export interface AreaPathCapable {
  listAreaPaths(): Promise<AreaPathTree>;
}

export function isAreaPathCapable(x: Integration): x is Integration & AreaPathCapable {
  return typeof (x as Partial<AreaPathCapable>).listAreaPaths === 'function';
}

/**
 * An integration that can add/remove a label on an issue / work item — the watch/ignore
 * toggle.
 */
export interface IssueLabelCapable {
  setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
}

export function isIssueLabelCapable(x: Integration): x is Integration & IssueLabelCapable {
  return typeof (x as Partial<IssueLabelCapable>).setIssueLabel === 'function';
}

/**
 * An integration that can **close** a tracker item — the plan back-out's "this is not
 * really an issue".
 */
export interface IssueCloseCapable {
  closeIssue(input: IssueCloseInput): Promise<SendResult>;
}

export function isIssueCloseCapable(x: Integration): x is Integration & IssueCloseCapable {
  return typeof (x as Partial<IssueCloseCapable>).closeIssue === 'function';
}

/**
 * An integration that can move a work item to a provider-native state — the "in review"
 * back-off.
 */
export interface WorkItemStateCapable {
  setWorkItemState(input: WorkItemStateInput): Promise<SendResult>;
}

export function isWorkItemStateCapable(x: Integration): x is Integration & WorkItemStateCapable {
  return typeof (x as Partial<WorkItemStateCapable>).setWorkItemState === 'function';
}

/**
 * An integration that can **place** a work item on the backlog: set the container it rolls
 * up to, and the classification node that puts it on a team's board.
 */
export interface WorkItemPlacementCapable {
  setWorkItemParent(input: WorkItemParentInput): Promise<SendResult>;
  setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
}

export function isWorkItemPlacementCapable(x: Integration): x is Integration & WorkItemPlacementCapable {
  return typeof (x as Partial<WorkItemPlacementCapable>).setWorkItemParent === 'function';
}

/**
 * An integration that can hang a pull-request link off a work item — the relation Azure's
 * **Check for linked work items** policy reads.
 */
export interface WorkItemLinkCapable {
  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult>;
}

export function isWorkItemLinkCapable(x: Integration): x is Integration & WorkItemLinkCapable {
  return typeof (x as Partial<WorkItemLinkCapable>).linkWorkItem === 'function';
}

/** An integration that can **create** a tracker item. */
export interface IssueCreateCapable {
  createIssue(input: IssueCreateInput): Promise<SendResult>;
}

export function isIssueCreateCapable(x: Integration): x is Integration & IssueCreateCapable {
  return typeof (x as Partial<IssueCreateCapable>).createIssue === 'function';
}

/** An integration that can comment on an issue / work item — the plan's status comment. */
export interface IssueCommentCapable {
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult>;
}

export function isIssueCommentCapable(x: Integration): x is Integration & IssueCommentCapable {
  return typeof (x as Partial<IssueCommentCapable>).upsertIssueComment === 'function';
}

// ---------------------------------------------------------------------------
// Injectable (fake-only)
//
// Injecting events is a *fake* concern — real providers read from the network,
// you don't inject into GitHub. Only fake integrations implement this, and the
// composite routes an injected event to the fake that owns its kind.
// ---------------------------------------------------------------------------

export interface Injectable {
  /** True if this integration knows how to apply an event of the given kind. */
  handles(kind: InjectableEvent['kind']): boolean;
  /** Apply an injectable event to this integration's world. */
  inject(event: InjectableEvent): void;
}

export function isInjectable(x: Integration): x is Integration & Injectable {
  const maybe = x as Partial<Injectable>;
  return typeof maybe.handles === 'function' && typeof maybe.inject === 'function';
}
