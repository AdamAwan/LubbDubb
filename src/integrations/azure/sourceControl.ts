import type { Store } from '../../store/store.js';
import type { MergeMethod, PrLabelInput, PrMergeInput, PrReplyInput, SendResult } from '../../sink/actionSink.js';
import type { CiStatus, MergeableState, PrComment, PullRequest } from '../../types.js';
import type {
  Capability,
  Integration,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  WorldSlice,
} from '../integration.js';
import type { AzStatus, AzThread, AzureDevOpsApi } from './azureDevOpsApi.js';

export interface AzureSourceControlOpts {
  /** The Azure DevOps client, already bound to a single organization/project/repository. */
  api: AzureDevOpsApi;
  store: Store;
  /** Only surface PRs opened by this uniqueName. Unset = all active PRs. */
  prAuthor?: string;
}

/**
 * The real `sourceControl` provider for Azure DevOps Repos: reads pull requests
 * (and the merge-readiness signals the PR-monitoring loop drives on) from the
 * Azure DevOps REST API, and posts replies / completes (merges) through it. A
 * drop-in for {@link GitHubSourceControlIntegration} — same {@link Integration} +
 * {@link PrReplyCapable} + {@link PrMergeCapable} seams, reading from the network
 * instead of an injected fake world, so it is *not* `Injectable`.
 */
export class AzureDevOpsSourceControlIntegration
  implements Integration, PrReplyCapable, PrMergeCapable, PrLabelCapable
{
  readonly id = 'sourceControl:azure';
  readonly capability: Capability = 'sourceControl';

  /** Last successful slice, served on a transient failure so PRs don't flap. */
  private lastGood: PullRequest[] = [];
  /** commitId per PR from the last snapshot — needed to complete a merge later. */
  private mergeCommits = new Map<number, string>();

  constructor(private readonly opts: AzureSourceControlOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerUniqueName();
      let pulls = await api.listActivePullRequests();
      if (prAuthor) pulls = pulls.filter((p) => p.authorUniqueName === prAuthor);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          const [threads, statuses, labels] = await Promise.all([
            api.listPullThreads(p.pullRequestId),
            api.listPullStatuses(p.pullRequestId),
            api.listPullLabels(p.pullRequestId),
          ]);
          this.mergeCommits.set(p.pullRequestId, p.lastMergeSourceCommit);
          const pr: PullRequest = {
            id: `pr_${p.pullRequestId}`,
            number: p.pullRequestId,
            title: p.title,
            branch: p.branch,
            baseBranch: p.baseBranch,
            ciStatus: aggregateCiStatus(statuses),
            unresolvedComments: buildUnresolvedComments(threads, viewer),
            approved: computeApproved(p.reviewerVotes),
            mergeableState: normalizeMergeState(p.mergeStatus, p.isDraft),
            merged: false, // active PRs only; a completed PR drops out of the list
            labels,
            url: p.url,
          };
          // Only assert (not-)mergeable when Azure reports a concrete state; leave
          // it unknown while it is still computing ('queued'/'notSet'), mirroring
          // GitHub's tri-state `mergeable`.
          const mergeable = mergeableFromStatus(p.mergeStatus);
          if (mergeable !== undefined) pr.mergeable = mergeable;
          return pr;
        }),
      );

      this.lastGood = pullRequests;
      return { pullRequests };
    } catch (err) {
      this.opts.store.recordConnectorEvent('azure_snapshot_error', {
        capability: this.capability,
        message: (err as Error).message,
      });
      return { pullRequests: this.lastGood };
    }
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    // Azure threads a reply under a thread; the fake/domain `commentId` carries the
    // thread id. A null commentId means "no thread to reply under" → open a new one.
    const ref =
      input.commentId !== null
        ? await api.createThreadReply(input.prNumber, Number(input.commentId), 1, input.body)
        : await api.createThread(input.prNumber, input.body);
    this.opts.store.recordConnectorEvent('pr_reply_sent', { ...input, ref: ref.url });
    return { ok: true, ref: ref.url };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const commit = this.mergeCommits.get(input.prNumber);
    if (!commit) {
      // We never snapshotted this PR, so we lack the head commit Azure requires to
      // complete it. Surface it rather than send a request Azure will reject.
      throw new Error(`no known merge commit for PR ${input.prNumber}; snapshot it before merging`);
    }
    const result = await this.opts.api.completePullRequest(input.prNumber, commit, input.method);
    const ok = result.status === 'completed' || result.status === 'queued';
    this.opts.store.recordConnectorEvent('pr_merge_sent', { ...input, ref: result.status });
    return { ok, ref: result.status };
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    await this.opts.api.setPullLabel(input.prNumber, input.label, input.present);
    this.opts.store.recordConnectorEvent('pr_label_set', { ...input });
    return { ok: true };
  }
}

/** Strip a `refs/heads/` prefix down to the plain branch name. */
export function stripRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

/** Fold Azure's `mergeStatus` (+ draft flag) down to the values the harness reacts to. */
export function normalizeMergeState(mergeStatus: string, isDraft: boolean): MergeableState {
  // A draft can't be merged regardless of conflicts — treat it as blocked so the
  // harness surfaces it but never auto-acts, mirroring GitHub's 'blocked'.
  if (isDraft) return 'blocked';
  switch (mergeStatus) {
    case 'conflicts':
      return 'dirty';
    case 'succeeded':
      return 'clean';
    case 'rejectedByPolicy':
      return 'blocked';
    default:
      // 'queued' | 'notSet' | 'failure' | anything new — still computing/unknown.
      return 'unknown';
  }
}

/**
 * Azure's `mergeStatus` as a tri-state `mergeable`: `succeeded`/`conflicts` are
 * concrete, everything else (`queued`/`notSet`/...) is "still computing" → leave
 * it undefined rather than asserting not-mergeable.
 */
export function mergeableFromStatus(mergeStatus: string): boolean | undefined {
  if (mergeStatus === 'succeeded') return true;
  if (mergeStatus === 'conflicts') return false;
  return undefined;
}

const FAILING_STATES: ReadonlySet<string> = new Set(['failed', 'error']);

/**
 * Fold a PR's statuses into one {@link CiStatus}: any failure wins, else any
 * still-pending signal is `pending`, else a present success is `passing`, else
 * `unknown` (nothing has reported yet). Mirrors the GitHub aggregation.
 */
export function aggregateCiStatus(statuses: AzStatus[]): CiStatus {
  let failing = false;
  let pending = false;
  let success = false;

  for (const s of statuses) {
    if (s.state === 'pending' || s.state === 'notSet') pending = true;
    else if (s.state && FAILING_STATES.has(s.state)) failing = true;
    else if (s.state === 'succeeded') success = true;
    // 'notApplicable' / null contribute no signal.
  }

  if (failing) return 'failing';
  if (pending) return 'pending';
  if (success) return 'passing';
  return 'unknown';
}

/**
 * Approved iff at least one reviewer voted approve (10) or approve-with-suggestions
 * (5) and no reviewer is rejecting (-10) or waiting-for-author (-5) — the Azure
 * analogue of GitHub's "an APPROVED with no outstanding CHANGES_REQUESTED".
 */
export function computeApproved(votes: number[]): boolean {
  if (votes.some((v) => v < 0)) return false;
  return votes.some((v) => v >= 5);
}

/**
 * Surface one {@link PrComment} per PR comment thread, keyed on the thread id. A
 * thread is `handled` once Azure marks it resolved (fixed/closed/wontFix/byDesign)
 * *or* the bot authored its latest human comment — the network-native analogue of
 * the fake's `markCommentHandled`, so the deterministic loop settles one poll after
 * a reply is posted. System comments (status changes, etc.) are ignored.
 */
export function buildUnresolvedComments(threads: AzThread[], viewer: string): PrComment[] {
  const RESOLVED: ReadonlySet<string> = new Set(['fixed', 'closed', 'wontFix', 'byDesign']);
  const out: PrComment[] = [];
  for (const thread of threads) {
    const comments = thread.comments.filter((c) => c.commentType !== 'system');
    const root = comments[0];
    if (!root) continue; // a purely-system thread carries no reviewer signal
    const last = comments[comments.length - 1]!;
    const resolved = thread.status !== null && RESOLVED.has(thread.status);
    out.push({
      id: String(thread.id),
      author: root.authorUniqueName,
      body: root.content,
      handled: resolved || last.authorUniqueName === viewer,
    });
  }
  return out;
}

/** Map the domain merge method onto Azure's completion `mergeStrategy`. */
export function mergeStrategyFor(method: MergeMethod): string {
  switch (method) {
    case 'squash':
      return 'squash';
    case 'rebase':
      return 'rebase';
    default:
      return 'noFastForward'; // a real merge commit
  }
}
