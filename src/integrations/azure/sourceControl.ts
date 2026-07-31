import type { ErrorRecorder } from '../../errorLog.js';
import type {
  MergeMethod,
  PrBaseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { CiCheck, CiStatus, MergeableState, PrComment, PullRequest } from '../../types.js';
import type {
  Capability,
  Integration,
  PrBaseCapable,
  PrCreateCapable,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  PrTitleCapable,
  WorldSlice,
} from '../integration.js';
import { closedWindowStart } from '../closedWindow.js';
import type { AzClosedPull, AzPolicyEvaluation, AzThread, AzureDevOpsApi } from './azureDevOpsApi.js';
import { policyCheckMode, policyKindOf, type PolicyCheckModes } from './policyKinds.js';

interface AzureSourceControlOpts {
  /** The Azure DevOps client, already bound to a single organization/project/repository. */
  api: AzureDevOpsApi;
  /** Central error sink: snapshot failures surface in the cockpit's Errors panel. */
  errors?: ErrorRecorder;
  /** Only surface PRs opened by this uniqueName. Unset = all active PRs. */
  prAuthor?: string;
  /** Which branch-policy kinds become CI checks, and at what mode. Unset = the defaults. */
  policyChecks?: PolicyCheckModes;
  /**
   * How far back to look for PRs that have left the active set
   * (`config.closedPrWindowMs`). 0 / unset skips the lookup entirely.
   */
  closedPrWindowMs?: number;
  /** Injectable clock, so the retention window is testable without waiting for one. */
  now?: () => number;
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
  implements Integration, PrReplyCapable, PrMergeCapable, PrLabelCapable, PrCreateCapable, PrTitleCapable, PrBaseCapable
{
  readonly id = 'sourceControl:azure';
  readonly capability: Capability = 'sourceControl';

  /** Last successful slice, served on a transient failure so PRs don't flap. */
  private lastGood: PullRequest[] = [];
  private lastGoodClosed: PullRequest[] = [];
  /** commitId per PR from the last snapshot — needed to complete a merge later. */
  private mergeCommits = new Map<number, string>();

  constructor(private readonly opts: AzureSourceControlOpts) {}

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerUniqueName();
      let pulls = await api.listActivePullRequests();
      if (prAuthor) pulls = pulls.filter((p) => p.authorUniqueName === prAuthor);
      const closedPullRequests = await this.recentlyClosed();

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          const [threads, policyEvals, labels] = await Promise.all([
            api.listPullThreads(p.pullRequestId),
            api.listPolicyEvaluations(p.pullRequestId),
            api.listPullLabels(p.pullRequestId),
          ]);
          this.mergeCommits.set(p.pullRequestId, p.lastMergeSourceCommit);
          const pr: PullRequest = {
            id: `pr_${p.pullRequestId}`,
            number: p.pullRequestId,
            title: p.title,
            branch: p.branch,
            baseBranch: p.baseBranch,
            ciStatus: aggregatePolicyCiStatus(policyEvals),
            ciChecks: listPolicyCiChecks(policyEvals, this.opts.policyChecks),
            unresolvedComments: buildUnresolvedComments(threads, viewer),
            approved: computeApproved(p.reviewerVotes),
            mergeableState: normalizeMergeState(p.mergeStatus, p.isDraft),
            merged: false, // active PRs only; a completed PR drops out of the list
            state: 'open',
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
   * The PRs that left the active set inside the retention window, in the same
   * domain shape as an active one — minus every signal only an *open* PR has
   * (policy evaluations, threads, labels), which is what keeps this one request.
   */
  private async recentlyClosed(): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPullRequests(since);
    return closed.filter((p) => !prAuthor || p.authorUniqueName === prAuthor).map(mapClosedPull);
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    // Azure threads a reply under a thread; the fake/domain `commentId` carries the
    // thread id. A null commentId means "no thread to reply under" → open a new one.
    const ref =
      input.commentId !== null
        ? await api.createThreadReply(input.prNumber, Number(input.commentId), 1, input.body)
        : await api.createThread(input.prNumber, input.body);
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
    return { ok, ref: result.status };
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    await this.opts.api.setPullLabel(input.prNumber, input.label, input.present);
    return { ok: true };
  }

  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    const { pullRequestId } = await this.opts.api.createPull({
      head: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { ok: true, ref: String(pullRequestId) };
  }

  async setPullTitle(input: PrTitleInput): Promise<SendResult> {
    await this.opts.api.setPullTitle(input.prNumber, input.title);
    return { ok: true };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }
}

/**
 * A completed/abandoned Azure PR as the world models it. CI and comments are
 * blanked rather than fetched: nothing acts on a closed PR, and per-PR fan-out is
 * exactly the cost this feature must not have.
 */
export function mapClosedPull(p: AzClosedPull): PullRequest {
  return {
    id: `pr_${p.pullRequestId}`,
    number: p.pullRequestId,
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

/**
 * Fold a PR's *branch-policy evaluations* into one {@link CiStatus} — the
 * authoritative "are the required checks passing?" signal.
 *
 * **Deliberately frozen** at enabled + blocking + build/status, with no
 * configuration reaching it. `ciStatus` is what `prHealth`'s blocked verdict and
 * the merge rule read, so anything an operator can widen must be unable to claim
 * a PR cannot merge when Azure would complete it — or to stop the harness
 * merging one it would. Widening happens in {@link listPolicyCiChecks} instead,
 * and rule 1 reads that through `ciNeedsAttention`. Reviewer / comment /
 * work-item / merge-strategy policies are human or process gates that already
 * map onto `approved` / `unresolvedComments` / `mergeableState`, so folding them
 * in here would report "CI failing" for an unmet minimum-reviewers rule.
 *
 * This replaces aggregating the PR *statuses* endpoint, which returns every
 * status ever posted across *all* iterations: one stale `failed` from a
 * superseded push permanently poisoned the PR to `failing`. Policy evaluations
 * instead reflect only the current state of the policies that apply now, so no
 * per-iteration de-dup is needed. A `rejected`/`broken` one wins (`failing`),
 * else a `queued`/`running` one is `pending`, else an `approved` one is
 * `passing`, else `unknown` (no CI policy applies — a repo with no build/status
 * branch policy has no required check to gate on).
 */
export function aggregatePolicyCiStatus(evals: AzPolicyEvaluation[]): CiStatus {
  let failing = false;
  let pending = false;
  let passing = false;

  for (const e of evals) {
    const kind = policyKindOf(e.typeId);
    if (!e.isEnabled || !e.isBlocking || (kind !== 'build' && kind !== 'status')) continue;
    switch (e.status) {
      case 'rejected':
      case 'broken': // the policy errored — it still blocks the merge, so treat it as failing.
        failing = true;
        break;
      case 'queued':
      case 'running':
        pending = true;
        break;
      case 'approved':
        passing = true;
        break;
      // 'notApplicable' / null contribute no signal.
    }
  }

  if (failing) return 'failing';
  if (pending) return 'pending';
  if (passing) return 'passing';
  return 'unknown';
}

/**
 * Every policy evaluation the operator asked to see, kept individually so
 * per-check policy can act on *which* one failed.
 *
 * Wider than the fold above in both directions an operator needs: *Optional*
 * (non-blocking) policies are included, carrying `blocking: false`, because such
 * a check really does fail and an agent really can fix it; and the non-CI kinds
 * are included at whatever mode they are configured at. A **disabled** policy is
 * dropped whatever its mode — its evaluation is stale noise.
 *
 * A policy with no name is no longer skipped: `policyDisplayName` now falls back
 * through the build definition name to the policy type's own, so "unnameable" has
 * stopped being a state an evaluation can be in. The clause it replaces existed
 * because a nameless check cannot be matched by a glob and emitting one would let
 * a single empty pattern claim several unrelated checks at once.
 */
export function listPolicyCiChecks(evals: AzPolicyEvaluation[], modes?: PolicyCheckModes): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const e of evals) {
    if (!e.isEnabled) continue;
    const mode = policyCheckMode(policyKindOf(e.typeId), modes);
    if (mode === 'off') continue;
    const status = checkStatusOf(e.status);
    if (!status) continue;
    const check: CiCheck = { name: e.displayName, status, blocking: e.isBlocking };
    if (mode === 'advisory') check.advisory = true;
    checks.push(check);
  }
  return checks;
}

/** A policy evaluation status as a {@link CiCheck} status, or null for no signal. */
function checkStatusOf(status: string | null): CiCheck['status'] | null {
  if (status === 'rejected' || status === 'broken') return 'failing';
  if (status === 'queued' || status === 'running') return 'pending';
  if (status === 'approved') return 'passing';
  // 'notApplicable' / null contribute no signal, exactly as in the fold.
  return null;
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
