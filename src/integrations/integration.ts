import type { Config } from '../config.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { InjectableEvent } from '../connector/connector.js';
import type {
  BranchDeleteInput,
  CiCheckRequeueInput,
  FilingTarget,
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
import type { CiEvidenceTarget, CiFailureEvidence } from '../ci/ciEvidence.js';
import type { TrackerItem, WorldSnapshot } from '../types.js';

/**
 * A modular integration owns exactly one *slice* of the outside world.
 *
 * The harness reads the world through a single {@link Connector} and writes
 * through a single {@link ActionSink}, but behind those seams the world is
 * assembled from many small integrations — one per **capability** (source
 * control, issues, …). Each capability has interchangeable
 * **provider** implementations (a fake one here; a real GitHub / Azure DevOps one
 * later) selected in config, so swapping the provider for a
 * capability is a config change, not a code change. See {@link CompositeConnector}
 * for how the slices are merged and {@link buildIntegrations} for how config
 * chooses the providers.
 */

/** The kinds of integration the harness understands. Mirrors {@link WorldSnapshot}. */
export type Capability = 'sourceControl' | 'issues';

/** One provider chosen per capability. This is the swap switch (set in config). */
export type IntegrationSelection = Record<Capability, string>;

/**
 * One integration's contribution to the world — only the domains it owns.
 *
 * `stale` is the one field that is not a domain: an integration whose read failed
 * serves its last known good lists rather than nothing, and sets this so the
 * composite can name it on {@link WorldSnapshot.staleSources}. Optional, so a
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
  /** Which capability this integration fulfils. Exactly one provider per capability. */
  readonly capability: Capability;
  /** This integration's slice of the world right now. Called every dispatch cycle. */
  snapshot(): Promise<WorldSlice>;
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

/** An integration that can merge a pull request — the outbound side of PR monitoring. */
export interface PrMergeCapable {
  mergePr(input: PrMergeInput): Promise<SendResult>;
}

export function isPrMergeCapable(x: Integration): x is Integration & PrMergeCapable {
  return typeof (x as Partial<PrMergeCapable>).mergePr === 'function';
}

/**
 * An integration that can turn a harness reference into a canonical web URL — the
 * seam that keeps URL construction in the provider (which knows the repo identity)
 * rather than the provider-agnostic cockpit. Refs it can't map return `null`.
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

/**
 * An integration that can open a pull request — the harness authoring its own.
 *
 * Separate from {@link PrTitleCapable} and {@link PrBaseCapable} rather than one
 * "PR write" capability, because a provider genuinely may have one and not the
 * others: GitHub retargets a stack itself on merge, so its `setPullBase` exists
 * only for the hand-driven case, while Azure needs it on every merge.
 */
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
 * An integration that can bring a pull request up to date with its base
 * server-side — the provider's own "update branch" (issue #332).
 *
 * Separate from {@link PrBaseCapable}, which *retargets* a pull request: one
 * changes which branch is merged into, the other merges it in. GitHub has both;
 * Azure DevOps has only the first, which is precisely why this is its own
 * capability rather than a method on a widened one — an integration says what it
 * can do, and the composite answers `ok: false` when nothing can.
 */
export interface PrBaseUpdateCapable {
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
}

export function isPrBaseUpdateCapable(x: Integration): x is Integration & PrBaseUpdateCapable {
  return typeof (x as Partial<PrBaseUpdateCapable>).updatePrBranch === 'function';
}

/**
 * An integration that can **queue a fresh run of an expired CI check** — the gate
 * whose cause the harness already knows (issue #395).
 *
 * Its own capability rather than a method on {@link CiEvidenceCapable}, which is
 * the other per-check provider call: that one reads a failure, this one writes.
 * Only the Azure provider implements it, and only because only Azure has the
 * state — a blocking build policy that sits `queued` forever with nothing in
 * flight. GitHub has no equivalent, so the composite answers `ok: false` and the
 * gate keeps the agent it always had.
 */
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
 * An integration that can fetch the **failing output** of a red CI check, so a
 * CI-fix dispatch carries the assertion rather than only the check's name.
 *
 * Listed among the outbound capabilities for want of a better home, and it is
 * worth being clear that it is not one: this reads, it changes nothing. It is
 * kept off {@link Integration.snapshot} deliberately — the snapshot runs every
 * pulse for every open pull request, and a log fetch there would be paid on every
 * pulse and used on almost none of them (see the request-budget note in
 * `docs/spec/15-integrations.md`). This is asked once per actual dispatch.
 *
 * A provider answers only for the checks it wrote an {@link CiCheck.evidenceRef}
 * for, and returns fewer entries than it was asked about — or none — rather than
 * throwing. → [`src/ci/ciEvidence.ts`]
 */
export interface CiEvidenceCapable {
  readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]>;
}

export function isCiEvidenceCapable(x: Integration): x is Integration & CiEvidenceCapable {
  return typeof (x as Partial<CiEvidenceCapable>).readCiFailureEvidence === 'function';
}

/**
 * An integration that can list the tracker items it owns **across states**, not
 * just the open ones — what the ticket mirror is filled from (issue #329).
 *
 * Its own capability rather than a widening of {@link Integration.snapshot},
 * because it answers a different question and must not be confused with one. The
 * snapshot is *the world the harness acts on*, and that is open items by
 * definition — a rule that could see closed ones would eventually act on one. This
 * reads history, nothing dispatches from it, and a provider that cannot answer
 * simply is not capable: the sweep then writes nothing and the tab is empty rather
 * than wrong.
 *
 * **Narrowed exactly as the provider's own open list is** — the same tag and
 * assignee filters, applied in the same place — so the mirror can never hold a
 * different population from the one the harness works. Where a provider narrows
 * by nothing (GitHub today), the mirror is every issue in the repository, and that
 * is the honest answer rather than a second, quieter filter invented here.
 */
export interface TicketHistoryCapable {
  /**
   * Items in any state that the tracker last saw change at or after `since`.
   *
   * One call, paginated internally where the provider needs it — the shape
   * {@link GitHubApi.listRecentlyClosedPulls} already set, and for its reason: the
   * caller bounds the size by choosing `since`, so a seam that returned a cursor
   * would push paging into every caller to save nothing.
   */
  listTicketHistory(since: string): Promise<TrackerItem[]>;
}

export function isTicketHistoryCapable(x: Integration): x is Integration & TicketHistoryCapable {
  return typeof (x as Partial<TicketHistoryCapable>).listTicketHistory === 'function';
}

/** An integration that can add/remove a label on an issue / work item — the watch/ignore toggle. */
export interface IssueLabelCapable {
  setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
}

export function isIssueLabelCapable(x: Integration): x is Integration & IssueLabelCapable {
  return typeof (x as Partial<IssueLabelCapable>).setIssueLabel === 'function';
}

/** An integration that can move a work item to a provider-native state — the "in review" back-off. */
export interface WorkItemStateCapable {
  setWorkItemState(input: WorkItemStateInput): Promise<SendResult>;
}

export function isWorkItemStateCapable(x: Integration): x is Integration & WorkItemStateCapable {
  return typeof (x as Partial<WorkItemStateCapable>).setWorkItemState === 'function';
}

/**
 * An integration that can hang a pull-request link off a work item — the relation
 * Azure's **Check for linked work items** policy reads.
 *
 * Its own capability rather than a method on {@link WorkItemStateCapable}, for
 * {@link PrBaseUpdateCapable}'s reason: GitHub genuinely does not have it and does
 * not need it, since a `#12` in the body links the issue itself. So the composite
 * answers `ok: false` when nothing serves it, instead of throwing.
 */
export interface WorkItemLinkCapable {
  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult>;
}

export function isWorkItemLinkCapable(x: Integration): x is Integration & WorkItemLinkCapable {
  return typeof (x as Partial<WorkItemLinkCapable>).linkWorkItem === 'function';
}

/**
 * An integration that can **create** a tracker item — the seam the four filing
 * arms used to have no answer for (issue #394).
 *
 * Its own capability rather than a method on {@link IssueCommentCapable}, for
 * {@link PrBaseUpdateCapable}'s reason: a provider genuinely may read issues and
 * not accept new ones, and the honest answer there is "nothing serves this" rather
 * than a method that throws. Every issues provider in the tree implements it, and
 * a future read-only one would simply not.
 */
export interface IssueCreateCapable {
  createIssue(input: IssueCreateInput): Promise<SendResult>;
  /**
   * Where a filing would land and as whom — the live half of "can I file here"
   * (issue #413).
   *
   * On the same interface as {@link createIssue} rather than a capability of its
   * own, because it is not a second thing a provider might support: it is the
   * question "would `createIssue` work", and a provider that can create but cannot
   * say where would leave the operator filing blind into a tracker the cockpit
   * cannot name. Every implementer answers it.
   *
   * It **throws** rather than reporting a failure, exactly as `createIssue` does:
   * a credential that no longer works is a fault, and the caller — one route, for
   * one cockpit control — is the right place to decide what to show for it.
   */
  describeFilingTarget(): Promise<FilingTarget>;
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
