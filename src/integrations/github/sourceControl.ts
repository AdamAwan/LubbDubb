import type { Store } from '../../store/store.js';
import type { PrMergeInput, PrReplyInput, SendResult } from '../../sink/actionSink.js';
import type { CiStatus, PrComment, PullRequest } from '../../types.js';
import type { Capability, Integration, PrMergeCapable, PrReplyCapable, WorldSlice } from '../integration.js';
import type { GhCheckRun, GhCombinedStatus, GhReview, GhReviewComment, GitHubApi } from './githubApi.js';

export interface GitHubSourceControlOpts {
  /** The GitHub client, already bound to a single owner/repo. */
  api: GitHubApi;
  store: Store;
  /** Only surface PRs opened by this login. Unset = all open PRs. */
  prAuthor?: string;
}

/**
 * The real `sourceControl` provider: reads pull requests (and the merge-readiness
 * signals the PR-monitoring loop drives on) from the GitHub API, and posts replies
 * / merges through it. A drop-in for {@link FakeGitHubIntegration} — same
 * {@link Integration} + {@link PrReplyCapable} + {@link PrMergeCapable} seams, but
 * reading from the network instead of an injected fake world, so it is *not*
 * `Injectable`.
 */
export class GitHubSourceControlIntegration implements Integration, PrReplyCapable, PrMergeCapable {
  readonly id = 'sourceControl:github';
  readonly capability: Capability = 'sourceControl';

  /** Last successful slice, served on a transient failure so PRs don't flap. */
  private lastGood: PullRequest[] = [];

  constructor(private readonly opts: GitHubSourceControlOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerLogin();
      let pulls = await api.listOpenPulls();
      if (prAuthor) pulls = pulls.filter((p) => p.authorLogin === prAuthor);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          const [detail, reviews, comments, status, checks] = await Promise.all([
            api.getPull(p.number),
            api.listPullReviews(p.number),
            api.listPullReviewComments(p.number),
            api.getCombinedStatus(p.headSha),
            api.listCheckRuns(p.headSha),
          ]);
          const pr: PullRequest = {
            id: `pr_${p.number}`,
            number: p.number,
            title: p.title,
            branch: p.branch,
            ciStatus: aggregateCiStatus(checks, status),
            unresolvedComments: buildUnresolvedComments(comments, viewer),
            approved: computeApproved(reviews),
            merged: detail.merged,
            url: p.url,
          };
          // GitHub's tri-state `mergeable`: true/false is a real signal, null means
          // "still computing" — leave it unknown rather than asserting not-mergeable.
          if (detail.mergeable !== null) pr.mergeable = detail.mergeable;
          return pr;
        }),
      );

      this.lastGood = pullRequests;
      return { pullRequests };
    } catch (err) {
      this.opts.store.recordConnectorEvent('github_snapshot_error', {
        capability: this.capability,
        message: (err as Error).message,
      });
      return { pullRequests: this.lastGood };
    }
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    const ref =
      input.commentId !== null
        ? await api.createPullReviewReply(input.prNumber, Number(input.commentId), input.body)
        : await api.createIssueComment(input.prNumber, input.body);
    this.opts.store.recordConnectorEvent('pr_reply_sent', { ...input, ref: ref.url });
    return { ok: true, ref: ref.url };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const result = await this.opts.api.mergePull(input.prNumber, input.method);
    this.opts.store.recordConnectorEvent('pr_merge_sent', { ...input, ref: result.sha });
    return { ok: result.merged, ref: result.sha };
  }
}

const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);

/**
 * Fold check-runs and the legacy combined status into one {@link CiStatus}:
 * any failure wins, else any still-running signal is `pending`, else a present
 * success is `passing`, else `unknown` (nothing has reported yet).
 */
export function aggregateCiStatus(checkRuns: GhCheckRun[], status: GhCombinedStatus): CiStatus {
  let failing = false;
  let pending = false;
  let success = false;

  for (const run of checkRuns) {
    if (run.status !== 'completed') {
      pending = true;
    } else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion)) {
      failing = true;
    } else {
      success = true; // success / neutral / skipped
    }
  }

  if (status.totalCount > 0) {
    if (status.state === 'failure' || status.state === 'error') failing = true;
    else if (status.state === 'pending') pending = true;
    else if (status.state === 'success') success = true;
  }

  if (failing) return 'failing';
  if (pending) return 'pending';
  if (success) return 'passing';
  return 'unknown';
}

/** Approved iff at least one reviewer's latest review is APPROVED and none is CHANGES_REQUESTED. */
export function computeApproved(reviews: GhReview[]): boolean {
  const latest = new Map<string, GhReview>();
  for (const review of reviews) {
    // COMMENTED / PENDING reviews don't change a reviewer's approval stance.
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') continue;
    const prev = latest.get(review.reviewerLogin);
    if (!prev || (review.submittedAt ?? '') >= (prev.submittedAt ?? '')) latest.set(review.reviewerLogin, review);
  }
  const states = [...latest.values()].map((r) => r.state);
  if (states.includes('CHANGES_REQUESTED')) return false;
  return states.includes('APPROVED');
}

/**
 * Group review comments into threads (by `in_reply_to_id`) and surface one
 * {@link PrComment} per thread, keyed on the thread root. A thread is `handled`
 * once the authenticated bot authored its latest comment — the network-native
 * analogue of the fake's `markCommentHandled`, so the deterministic loop settles
 * one poll after a reply is posted.
 */
export function buildUnresolvedComments(comments: GhReviewComment[], viewerLogin: string): PrComment[] {
  const roots: GhReviewComment[] = [];
  const latestByRoot = new Map<number, GhReviewComment>();
  for (const c of comments) {
    const rootId = c.inReplyToId ?? c.id;
    if (c.inReplyToId === null) roots.push(c);
    // Comments arrive in creation order, so the last write per root is the latest.
    latestByRoot.set(rootId, c);
  }
  return roots.map((root) => ({
    id: String(root.id),
    author: root.authorLogin,
    body: root.body,
    handled: (latestByRoot.get(root.id) ?? root).authorLogin === viewerLogin,
  }));
}
