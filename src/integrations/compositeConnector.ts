import type { Connector, InjectableEvent } from '../connector/connector.js';
import type { ActionSink, PrMergeInput, PrReplyInput, SendResult } from '../sink/actionSink.js';
import type { Store } from '../store/store.js';
import type { WorldSnapshot } from '../types.js';
import { isInjectable, isPrMergeCapable, isPrReplyCapable, isRefResolvable, type Integration } from './integration.js';

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
export class CompositeConnector implements Connector, ActionSink {
  constructor(
    private readonly integrations: Integration[],
    private readonly store: Store,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async getState(): Promise<WorldSnapshot> {
    const slices = await Promise.all(this.integrations.map((i) => i.snapshot()));
    return {
      takenAt: this.now(),
      pullRequests: slices.flatMap((s) => s.pullRequests ?? []),
      issues: slices.flatMap((s) => s.issues ?? []),
      stories: slices.flatMap((s) => s.stories ?? []),
      calendar: slices.flatMap((s) => s.calendar ?? []),
    };
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
   * Apply an injected event to whichever fake integration owns its kind, then log
   * it. An event with no fake owner (e.g. its domain is served by a real adapter
   * that reads from the network) is recorded as an unhandled inject rather than
   * throwing — you cannot fake-inject onto a real provider.
   */
  inject(event: InjectableEvent): void {
    const target = this.integrations.find((i) => isInjectable(i) && i.handles(event.kind));
    if (target && isInjectable(target)) {
      target.inject(event);
      this.store.recordConnectorEvent(event.kind, event);
    } else {
      this.store.recordConnectorEvent('inject_unhandled', event);
    }
  }
}
