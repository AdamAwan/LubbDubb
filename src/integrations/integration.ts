import type { Config } from '../config.js';
import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { InjectableEvent } from '../connector/connector.js';
import type {
  IssueLabelInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  SendResult,
  WorkItemStateInput,
} from '../sink/actionSink.js';
import type { WorldSnapshot } from '../types.js';

/**
 * A modular integration owns exactly one *slice* of the outside world.
 *
 * The harness reads the world through a single {@link Connector} and writes
 * through a single {@link ActionSink}, but behind those seams the world is
 * assembled from many small integrations — one per **capability** (source
 * control, issues, calendar, …). Each capability has interchangeable
 * **provider** implementations (a fake one here; a real GitHub / Azure DevOps /
 * Google / Outlook one later) selected in config, so swapping the provider for a
 * capability is a config change, not a code change. See {@link CompositeConnector}
 * for how the slices are merged and {@link buildIntegrations} for how config
 * chooses the providers.
 */

/** The kinds of integration the harness understands. Mirrors {@link WorldSnapshot}. */
export type Capability = 'sourceControl' | 'issues' | 'calendar';

/** One provider chosen per capability. This is the swap switch (set in config). */
export type IntegrationSelection = Record<Capability, string>;

/** One integration's contribution to the world — only the domains it owns. */
export type WorldSlice = Partial<Pick<WorldSnapshot, 'pullRequests' | 'issues' | 'calendar'>>;

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
