import { nanoid } from 'nanoid';
import type { InjectableEvent } from '../../connector/connector.js';
import type {
  BranchDeleteInput,
  PrBaseInput,
  PrBaseUpdateInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { PullRequest } from '../../types.js';
import type {
  BranchDeleteCapable,
  WorldCapability,
  Injectable,
  Integration,
  PrBaseCapable,
  PrBaseUpdateCapable,
  PrCreateCapable,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  PrTitleCapable,
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
  'pr_closed',
]);

/**
 * The fake `sourceControl` provider: it owns the pull-request slice of the world,
 * including the merge-readiness signals the PR-monitoring loop drives on
 * (approval / mergeable / merged). A real GitHub / Azure DevOps adapter is a
 * drop-in replacement — it implements the same {@link Integration} +
 * {@link PrReplyCapable} + {@link PrMergeCapable} seams and gets registered under
 * `sourceControl` instead of this one.
 */
export class FakeGitHubIntegration
  implements
    Integration,
    PrReplyCapable,
    PrMergeCapable,
    PrLabelCapable,
    PrCreateCapable,
    PrTitleCapable,
    PrBaseCapable,
    PrBaseUpdateCapable,
    BranchDeleteCapable,
    Injectable
{
  readonly id = 'sourceControl:fake';
  readonly capability: WorldCapability = 'sourceControl';

  constructor(
    private readonly world: FakeWorldStore,
    /** Base an injected `new_pr` targets when the event doesn't name one. */
    private readonly defaultBranch = 'main',
  ) {}

  async snapshot(): Promise<WorldSlice> {
    const world = this.world.read();
    return { pullRequests: world.pullRequests, closedPullRequests: world.closedPullRequests };
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
        case 'pr_closed': {
          // The one place the fake models a PR *leaving* the world. `mergePr` above
          // deliberately doesn't: it marks the PR merged in place so the
          // deterministic loop settles on a world it can still read. Closing is the
          // separate, later fact, and it moves the row rather than copying it — a PR
          // in both lists would have the world diff report the same merge twice.
          const idx = world.pullRequests.findIndex((p) => p.number === event.prNumber);
          if (idx === -1) break;
          const [pr] = world.pullRequests.splice(idx, 1);
          const merged = event.merged ?? pr!.merged ?? false;
          world.closedPullRequests.push({
            ...pr!,
            merged,
            state: merged ? 'merged' : 'closed',
            closedAt: new Date().toISOString(),
            // A real provider reports the merge commit here and nowhere else, and
            // it is the only thing that can: the squash leaves the branch with no
            // ancestry link to its base. A fake that omitted it would let the
            // landing sweep pass every test while recording nothing in production.
            // Derived from the number rather than random so a test can name it.
            ...(merged ? { mergeCommitSha: event.mergeCommitSha ?? mergeShaFor(event.prNumber) } : {}),
          });
          break;
        }
        case 'new_pr':
          if (!world.pullRequests.some((p) => p.number === event.number)) {
            world.pullRequests.push({
              id: `pr_${nanoid(6)}`,
              number: event.number,
              title: event.title,
              branch: event.branch,
              baseBranch: event.baseBranch ?? this.defaultBranch,
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
   * so the loop settles. Nothing leaves the machine; a real GitHub sink would POST
   * here instead.
   */
  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    if (input.commentId) this.markCommentHandled(input.prNumber, input.commentId);
    const ref = `fake-reply_${nanoid(6)}`;
    return { ok: true, ref };
  }

  /**
   * The outbound side of PR monitoring: "merges" a PR by reflecting it back into
   * the fake world, marking it merged so the loop settles. Nothing leaves the
   * machine; a real GitHub sink would call the merge API.
   */
  async mergePr(input: PrMergeInput): Promise<SendResult> {
    this.world.mutate((world) => mutatePr(world, input.prNumber, (pr) => (pr.merged = true)));
    const ref = `fake-merge_${nanoid(6)}`;
    return { ok: true, ref };
  }

  /**
   * The outbound side of the exclusion-tag toggle: add/remove a label on the fake
   * PR. Idempotent — adding a present label or removing an absent one is a no-op.
   * A real GitHub sink would call the labels API here.
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
    return { ok: true, ref };
  }

  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    let number = 0;
    this.world.mutate((world) => {
      // Same shape an injected `new_pr` builds, so a harness-opened PR is
      // indistinguishable downstream from one that arrived from the world.
      number = world.pullRequests.reduce((max, p) => Math.max(max, p.number), 0) + 1;
      world.pullRequests.push({
        id: `pr_${nanoid(6)}`,
        number,
        title: input.title,
        branch: input.branch,
        baseBranch: input.base,
        ciStatus: 'pending',
        unresolvedComments: [],
        approved: false,
        mergeableState: 'unknown',
        merged: false,
        labels: [],
      });
    });
    return { ok: true, ref: String(number) };
  }

  async setPullTitle(input: PrTitleInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => (pr.title = input.title));
    });
    return { ok: true, ref: `fake-title_${nanoid(6)}` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    this.world.mutate((world) => {
      mutatePr(world, input.prNumber, (pr) => (pr.baseBranch = input.base));
    });
    return { ok: true, ref: `fake-base_${nanoid(6)}` };
  }

  /**
   * The outbound side of the base update (issue #332): "merges" the base in by
   * reflecting the result back into the fake world — the pull request stops being
   * behind — so the loop settles exactly as it does after a fake merge. A real
   * GitHub sink calls the update-branch endpoint here.
   *
   * `clean` rather than `unknown`, because that is what the provider reports after
   * the merge lands: the state the update was for is gone, and leaving it unknown
   * would have the merge rule read a pull request it can no longer say is ready.
   */
  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    this.world.mutate((world) =>
      mutatePr(world, input.prNumber, (pr) => {
        pr.mergeableState = 'clean';
        pr.mergeable = true;
      }),
    );
    return { ok: true, ref: `fake-base-update_${nanoid(6)}` };
  }

  /**
   * Delete a branch. The fake has no ref store — a branch exists here only as the
   * `branch` of some pull request, and the pull request outlives it — so there is
   * nothing to mutate and the reap's own record is what stops it asking twice.
   */
  deleteBranch(input: BranchDeleteInput): Promise<SendResult> {
    return Promise.resolve({ ok: true, ref: input.branch });
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

/**
 * The commit the fake says a pull request merged as. Deterministic, so a test can
 * assert on a landing without having to read one back out first.
 */
export function mergeShaFor(prNumber: number): string {
  return `merge${String(prNumber).padStart(7, '0')}`;
}
