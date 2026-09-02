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
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { PrThreadState, PullRequest } from '../../types.js';
import { threadComments } from '../../prThreads.js';
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
  PrThreadResolveCapable,
  PrTitleCapable,
  WorldSlice,
} from '../integration.js';
import type { FakeWorld, FakeWorldStore } from './fakeWorld.js';

const KINDS: ReadonlySet<InjectableEvent['kind']> = new Set([
  'new_pr',
  'pr_pushed',
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
    PrThreadResolveCapable,
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
        case 'pr_pushed':
          mutatePr(world, event.prNumber, (pr) => (pr.headSha = event.headSha));
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
          mutatePr(world, event.prNumber, (pr) => {
            const threads = pr.reviewThreads ?? [];
            threads.push({ id: `c_${nanoid(6)}`, author: event.author, body: event.body, state: 'open', replies: [] });
            // Threads are the fake's storage and the comment list is derived from
            // them, exactly as it is in both real providers — so a test driving the
            // fake exercises the same fold the harness ships.
            pr.reviewThreads = threads;
            pr.unresolvedComments = threadComments(threads);
          });
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
              reviewThreads: [],
              approved: false,
              // No `mergeable` yet — GitHub reports null while computing, and a
              // firm false would wrongly trip the conflict rule on a fresh PR.
              mergeableState: 'unknown',
              merged: false,
              labels: event.labels ?? [],
              ...(event.headSha === undefined ? {} : { headSha: event.headSha }),
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
    const replyId = input.commentId ? this.markCommentHandled(input.prNumber, input.commentId, input.body) : null;
    const ref = `fake-reply_${nanoid(6)}`;
    // The id of the reply it just minted, in the same vocabulary its own threads
    // carry — so the fake answers `commentRef` on the same terms a real provider
    // does and a test driving it exercises the attribution record rather than a
    // path only the fake has. Null when there was no thread to reply into.
    return { ok: true, ref, ...(replyId === null ? {} : { commentRef: replyId }) };
  }

  /**
   * The outbound side of resolving a review thread — the reviewer's own verdict,
   * which the fake now records as one: `resolved` rather than the `answered` a
   * reply leaves behind. The two were one flag while `handled` was the only thing
   * a thread carried, and a fake that still folded them would be the one place
   * the operator's reopen could not tell what it was undoing. A thread the world
   * does not carry is `ok: false`, the same stale-reading answer the real
   * providers give.
   */
  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    const { found } = this.setThreadState(input.prNumber, input.commentId, 'resolved');
    return { ok: found, ref: found ? `fake-resolve_${nanoid(6)}` : undefined };
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
        reviewThreads: [],
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

  /**
   * Reflect harness progress back so the deterministic dispatcher stops
   * re-triggering: the thread is `answered` — the fleet spoke last and the
   * reviewer has not come back — and the reply is written into it when one was
   * given, so a surface drawing the conversation draws what was actually said.
   *
   * Answers the id of the reply it wrote, or null when the world carried no such
   * thread — what `postPrReply` hands back as `commentRef`, so the fake's replies
   * are attributable by record exactly as a real provider's are.
   */
  markCommentHandled(prNumber: number, commentId: string, body?: string): string | null {
    return this.setThreadState(prNumber, commentId, 'answered', body).replyId;
  }

  /**
   * Move one thread, and re-derive the comment list from the threads — the single
   * fold, here as in both real providers. Answers whether the world carried the
   * thread at all.
   */
  private setThreadState(
    prNumber: number,
    commentId: string,
    state: PrThreadState,
    reply?: string,
  ): { found: boolean; replyId: string | null } {
    let found = false;
    let replyId: string | null = null;
    this.world.mutate((world) => {
      mutatePr(world, prNumber, (pr) => {
        const threads = pr.reviewThreads ?? [];
        const thread = threads.find((t) => t.id === commentId);
        if (!thread) return;
        found = true;
        thread.state = state;
        if (reply !== undefined) {
          replyId = `r_${nanoid(6)}`;
          thread.replies.push({ id: replyId, author: 'lubbdubb', body: reply, ours: true });
        }
        pr.reviewThreads = threads;
        pr.unresolvedComments = threadComments(threads);
      });
    });
    return { found, replyId };
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
