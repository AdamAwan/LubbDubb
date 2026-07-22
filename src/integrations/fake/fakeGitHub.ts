import { nanoid } from 'nanoid';
import type { Store } from '../../store/store.js';
import type { InjectableEvent } from '../../connector/connector.js';
import type { PrLabelInput, PrMergeInput, PrReplyInput, SendResult } from '../../sink/actionSink.js';
import type { PullRequest } from '../../types.js';
import type {
  Capability,
  Injectable,
  Integration,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  WorldSlice,
} from '../integration.js';
import type { FakeWorld, FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set([
  'new_pr',
  'ci_failed',
  'ci_passed',
  'pr_comment',
  'pr_approved',
  'pr_mergeable',
]);

/**
 * The fake `sourceControl` provider: it owns the pull-request slice of the world,
 * including the merge-readiness signals the PR-monitoring loop drives on
 * (approval / mergeable / merged). A real GitHub / Azure DevOps adapter is a
 * drop-in replacement — it implements the same {@link Integration} +
 * {@link PrReplyCapable} + {@link PrMergeCapable} seams and gets registered under
 * `sourceControl` instead of this one.
 */
export class FakeGitHubIntegration implements Integration, PrReplyCapable, PrMergeCapable, PrLabelCapable, Injectable {
  readonly id = 'sourceControl:fake';
  readonly capability: Capability = 'sourceControl';

  constructor(
    private readonly world: FakeWorldStore,
    private readonly store: Store,
  ) {}

  async snapshot(): Promise<WorldSlice> {
    return { pullRequests: this.world.read().pullRequests };
  }

  handles(kind: InjectableEvent['kind']): boolean {
    return KINDS.has(kind);
  }

  inject(event: InjectableEvent): void {
    this.world.mutate((world) => {
      switch (event.kind) {
        case 'ci_failed':
          mutatePr(world, event.prNumber, (pr) => (pr.ciStatus = 'failing'));
          break;
        case 'ci_passed':
          mutatePr(world, event.prNumber, (pr) => (pr.ciStatus = 'passing'));
          break;
        case 'pr_approved':
          mutatePr(world, event.prNumber, (pr) => (pr.approved = true));
          break;
        case 'pr_mergeable':
          mutatePr(world, event.prNumber, (pr) => {
            pr.mergeable = event.mergeable ?? true;
            if (event.mergeableState !== undefined) pr.mergeableState = event.mergeableState;
          });
          break;
        case 'pr_comment':
          mutatePr(world, event.prNumber, (pr) =>
            pr.unresolvedComments.push({
              id: `c_${nanoid(6)}`,
              author: event.author,
              body: event.body,
              handled: false,
            }),
          );
          break;
        case 'new_pr':
          if (!world.pullRequests.some((p) => p.number === event.number)) {
            world.pullRequests.push({
              id: `pr_${nanoid(6)}`,
              number: event.number,
              title: event.title,
              branch: event.branch,
              baseBranch: event.baseBranch ?? 'main',
              ciStatus: 'pending',
              unresolvedComments: [],
              approved: false,
              // No `mergeable` yet — GitHub reports null while computing, and a
              // firm false would wrongly trip the conflict rule on a fresh PR.
              mergeableState: 'unknown',
              merged: false,
              labels: event.labels ?? [],
            });
          }
          break;
      }
    });
  }

  /**
   * The outbound side of the fake source-control world. "Sends" a PR reply by
   * reflecting it back into the fake world — marking the answered comment handled
   * so the loop settles — and logging a connector event. Nothing leaves the
   * machine; a real GitHub sink would POST here instead.
   */
  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    if (input.commentId) this.markCommentHandled(input.prNumber, input.commentId);
    const ref = `fake-reply_${nanoid(6)}`;
    this.store.recordConnectorEvent('pr_reply_sent', { ...input, ref });
    return { ok: true, ref };
  }

  /**
   * The outbound side of PR monitoring: "merges" a PR by reflecting it back into
   * the fake world (marking it merged so the loop settles) and logging a connector
   * event. Nothing leaves the machine; a real GitHub sink would call the merge API.
   */
  async mergePr(input: PrMergeInput): Promise<SendResult> {
    this.world.mutate((world) => mutatePr(world, input.prNumber, (pr) => (pr.merged = true)));
    const ref = `fake-merge_${nanoid(6)}`;
    this.store.recordConnectorEvent('pr_merge_sent', { ...input, ref });
    return { ok: true, ref };
  }

  /**
   * The outbound side of the exclusion-tag toggle: add/remove a label on the fake
   * PR and log a connector event. Idempotent — adding a present label or removing
   * an absent one is a no-op. A real GitHub sink would call the labels API here.
   */
  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => {
        const labels = new Set(pr.labels ?? []);
        if (input.present) labels.add(input.label);
        else labels.delete(input.label);
        pr.labels = [...labels];
      });
    });
    const ref = `fake-label_${nanoid(6)}`;
    this.store.recordConnectorEvent('pr_label_set', { ...input, ref });
    return { ok: true, ref };
  }

  /** Reflect harness progress back so the deterministic dispatcher stops re-triggering. */
  markCommentHandled(prNumber: number, commentId: string): void {
    this.world.mutate((world) => {
      mutatePr(world, prNumber, (pr) => {
        const c = pr.unresolvedComments.find((x) => x.id === commentId);
        if (c) c.handled = true;
      });
    });
  }
}

function mutatePr(world: FakeWorld, prNumber: number, fn: (pr: PullRequest) => void): void {
  const pr = world.pullRequests.find((p) => p.number === prNumber);
  if (pr) fn(pr);
}
