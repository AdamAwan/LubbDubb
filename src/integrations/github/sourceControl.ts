import type { ErrorRecorder } from '../../errorLog.js';
import type { PrLabelInput, PrMergeInput, PrReplyInput, SendResult } from '../../sink/actionSink.js';
import type { CiCheck, CiStatus, MergeableState, PrComment, PullRequest } from '../../types.js';
import type {
  Capability,
  Integration,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  RefResolvable,
  WorldSlice,
} from '../integration.js';
import { closedWindowStart } from '../closedWindow.js';
import type { GhCheckRun, GhClosedPull, GhCombinedStatus, GhReview, GhReviewComment, GitHubApi } from './githubApi.js';
import { githubRefUrl } from './refUrl.js';

interface GitHubSourceControlOpts {
  /** The GitHub client, already bound to a single owner/repo. */
  api: GitHubApi;
  /** Central error sink: snapshot failures surface in the cockpit's Errors panel. */
  errors?: ErrorRecorder;
  /** Only surface PRs opened by this login. Unset = all open PRs. */
  prAuthor?: string;
  /** Repo identity for building web URLs. When unset, ref resolution returns null. */
  owner?: string;
  repo?: string;
  /**
   * How far back to look for PRs that have left the open set (`config.closedPrWindowMs`).
   * 0 / unset skips the lookup entirely, so the extra request is never paid for by
   * an operator who hasn't asked for closed-PR visibility.
   */
  closedPrWindowMs?: number;
  /** Injectable clock, so the retention window is testable without waiting for one. */
  now?: () => number;
}

/**
 * The real `sourceControl` provider: reads pull requests (and the merge-readiness
 * signals the PR-monitoring loop drives on) from the GitHub API, and posts replies
 * / merges through it. A drop-in for {@link FakeGitHubIntegration} — same
 * {@link Integration} + {@link PrReplyCapable} + {@link PrMergeCapable} seams, but
 * reading from the network instead of an injected fake world, so it is *not*
 * `Injectable`.
 */
export class GitHubSourceControlIntegration
  implements Integration, PrReplyCapable, PrMergeCapable, PrLabelCapable, RefResolvable
{
  readonly id = 'sourceControl:github';
  readonly capability: Capability = 'sourceControl';

  /** Last successful slice, served on a transient failure so PRs don't flap. */
  private lastGood: PullRequest[] = [];
  private lastGoodClosed: PullRequest[] = [];

  constructor(private readonly opts: GitHubSourceControlOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerLogin();
      let pulls = await api.listOpenPulls();
      if (prAuthor) pulls = pulls.filter((p) => p.authorLogin === prAuthor);
      const closedPullRequests = await this.recentlyClosed();

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
            baseBranch: p.baseBranch,
            ciStatus: aggregateCiStatus(checks, status),
            ciChecks: listCiChecks(checks, status),
            unresolvedComments: buildUnresolvedComments(comments, viewer),
            approved: computeApproved(reviews),
            mergeableState: normalizeMergeState(detail.mergeableState),
            merged: detail.merged,
            // Listed as open, so 'open' unless the detail read caught it mid-merge.
            state: detail.merged ? 'merged' : 'open',
            labels: p.labels,
            url: p.url,
          };
          // GitHub's tri-state `mergeable`: true/false is a real signal, null means
          // "still computing" — leave it unknown rather than asserting not-mergeable.
          if (detail.mergeable !== null) pr.mergeable = detail.mergeable;
          return pr;
        }),
      );

      this.lastGood = pullRequests;
      this.lastGoodClosed = closedPullRequests;
      return { pullRequests, closedPullRequests };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      return { pullRequests: this.lastGood, closedPullRequests: this.lastGoodClosed };
    }
  }

  /**
   * The PRs that left the open set inside the retention window, in the same
   * domain shape as an open one. They carry no CI/review/comment signal — nothing
   * acts on a dead PR, and fetching those per PR is exactly the cost this feature
   * mustn't have.
   */
  private async recentlyClosed(): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPulls(since);
    return closed.filter((p) => !prAuthor || p.authorLogin === prAuthor).map(mapClosedPull);
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    const ref =
      input.commentId !== null
        ? await api.createPullReviewReply(input.prNumber, Number(input.commentId), input.body)
        : await api.createIssueComment(input.prNumber, input.body);
    return { ok: true, ref: ref.url };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const result = await this.opts.api.mergePull(input.prNumber, input.method);
    return { ok: result.merged, ref: result.sha };
  }

  resolveRefUrl(ref: string): string | null {
    const { owner, repo } = this.opts;
    return owner && repo ? githubRefUrl(owner, repo, ref) : null;
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    await this.opts.api.setPullLabel(input.prNumber, input.label, input.present);
    return { ok: true };
  }
}

/**
 * A closed GitHub PR as the world models it. `ciStatus`/`unresolvedComments` are
 * blanked rather than fetched: this row exists to be *seen* (in the cockpit, in
 * the world diff, in plan reconciliation), never to be acted on, and the harness
 * only reaches those fields for open PRs.
 */
export function mapClosedPull(p: GhClosedPull): PullRequest {
  return {
    id: `pr_${p.number}`,
    number: p.number,
    title: p.title,
    branch: p.branch,
    baseBranch: p.baseBranch,
    ciStatus: 'unknown',
    unresolvedComments: [],
    state: p.merged ? 'merged' : 'closed',
    merged: p.merged,
    closedAt: p.closedAt,
    url: p.url,
  };
}

/** Fold GitHub's `mergeable_state` down to the values the harness reacts to. */
function normalizeMergeState(state: string | null): MergeableState {
  switch (state) {
    case 'dirty':
    case 'behind':
    case 'blocked':
    case 'clean':
      return state;
    default:
      // 'unstable' | 'has_hooks' | 'draft' | 'unknown' | null | anything new.
      return 'unknown';
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

/**
 * The same signals {@link aggregateCiStatus} folds, kept individually so
 * per-check policy can act on *which* check failed.
 *
 * Deliberately a second pass over the same inputs rather than a richer return
 * from the fold: every existing caller wants the one-word verdict, and a check
 * list threaded through them would be carried nowhere and dropped everywhere.
 * The two agree by construction — same inputs, same failing/pending rules.
 */
export function listCiChecks(checkRuns: GhCheckRun[], status: GhCombinedStatus): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const run of checkRuns) {
    if (run.status !== 'completed') checks.push({ name: run.name, status: 'pending' });
    else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion))
      checks.push({ name: run.name, status: 'failing' });
    else checks.push({ name: run.name, status: 'passing' });
  }
  for (const s of status.statuses ?? []) {
    if (s.state === 'failure' || s.state === 'error') checks.push({ name: s.context, status: 'failing' });
    else if (s.state === 'pending') checks.push({ name: s.context, status: 'pending' });
    else checks.push({ name: s.context, status: 'passing' });
  }
  return checks;
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
