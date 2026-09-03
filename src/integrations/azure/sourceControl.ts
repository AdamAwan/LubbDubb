import type { ErrorRecorder } from '../../errorLog.js';
import type {
  BranchDeleteInput,
  CiCheckRequeueInput,
  MergeMethod,
  PrBaseInput,
  PrCloseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { CiCheck, CiStatus, MergeableState, PrReviewThread, PullRequest, ViewerAssignment } from '../../types.js';
import { ourReplyRefs, threadComments, threadState, type SentPrReplies } from '../../prThreads.js';
import { EVIDENCE_LOG_TAIL_LINES, type CiEvidenceTarget, type CiFailureEvidence } from '../../ci/ciEvidence.js';
import type {
  BranchDeleteCapable,
  WorldCapability,
  CiCheckRequeueCapable,
  CiEvidenceCapable,
  Integration,
  PrBaseCapable,
  PrCloseCapable,
  PrCreateCapable,
  PrLabelCapable,
  PrMergeCapable,
  PrReplyCapable,
  PrThreadResolveCapable,
  PrTitleCapable,
  RefResolvable,
  WorldSlice,
} from '../integration.js';
import { closedWindowStart } from '../closedWindow.js';
import type {
  AzClosedPull,
  AzPolicyEvaluation,
  AzPull,
  AzReviewer,
  AzThread,
  AzTimelineRecord,
  AzureDevOpsApi,
} from './azureDevOpsApi.js';
import { azureRefUrl } from './refUrl.js';
import { policyCheckMode, policyKindOf, type PolicyCheckModes } from './policyKinds.js';
import { HydrationCache } from '../hydrationCache.js';
import { hydrationMaxAgeMs, prReadRef, type ReadPlan } from '../../world/readPlan.js';

interface AzureSourceControlOpts {
  /** The Azure DevOps client, already bound to a single organization/project/repository. */
  api: AzureDevOpsApi;
  /** Central error sink: snapshot failures surface in the cockpit's Errors panel. */
  errors?: ErrorRecorder;
  /**
   * Azure target identity, for building web URLs. When unset, ref resolution
   * returns null — the same contract `GitHubSourceControlIntegration` has for
   * owner/repo.
   */
  organization?: string;
  project?: string;
  repository?: string;
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
  /**
   * The record of which replies this harness actually sent — what decides whether
   * a reply is the fleet's. Threaded in from `src/system.ts` via the registry, on
   * the same terms as the GitHub provider's: the two must not come to disagree
   * about a thread, which is why there is one derivation in `src/prThreads.ts`.
   * Unset means "no record", and every thread then reads as unanswered work.
   * → `docs/spec/07-pull-requests.md#review-threads`
   */
  sentReplies?: SentPrReplies;
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
  implements
    Integration,
    PrReplyCapable,
    PrThreadResolveCapable,
    PrMergeCapable,
    PrCloseCapable,
    PrLabelCapable,
    PrCreateCapable,
    PrTitleCapable,
    PrBaseCapable,
    BranchDeleteCapable,
    CiEvidenceCapable,
    CiCheckRequeueCapable,
    RefResolvable
{
  readonly id = 'sourceControl:azure';
  readonly capability: WorldCapability = 'sourceControl';

  /** Last successful slice, served on a transient failure so PRs don't flap. */
  private lastGood: PullRequest[] | null = null;
  private lastGoodClosed: PullRequest[] | null = null;
  /** commitId per PR from the last snapshot — needed to complete a merge later. */
  private mergeCommits = new Map<number, string>();
  /**
   * The branch-policy evaluations from the last fan-out, beside the token they
   * were read against — the one per-PR read this provider can skip. See
   * {@link policyEvaluations} for what that token covers and what it does not.
   *
   * Nothing to do with {@link lastGood}: that is the degradation path and says so
   * with `stale: true`, this is a current reading that cost no request.
   */
  private readonly policyReadings = new HydrationCache<{ token: string; evals: AzPolicyEvaluation[] }>();

  constructor(private readonly opts: AzureSourceControlOpts) {}

  /**
   * Resolves *every* ref shape, work items included, not just the ones this
   * capability owns: `CompositeConnector.resolveRefUrl` routes to the first
   * resolvable integration, and `sourceControl` is built first.
   */
  resolveRefUrl(ref: string): string | null {
    const { organization, project, repository } = this.opts;
    return organization && project && repository ? azureRefUrl(organization, project, repository, ref) : null;
  }

  async snapshot(plan?: ReadPlan): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerUniqueName();
      let pulls = await api.listActivePullRequests();
      // "Your work" is what you opened **or what somebody asked you for**. Narrowed
      // to authorship alone, a pull request that named the operator as a reviewer
      // never entered the world at all, so nothing could report the assignment and
      // the queue could not raise it — on the default `ownWorkOnly`, which is every
      // real deployment. It costs no request: the reviewer list rides on the same
      // page the filter already reads.
      if (prAuthor) {
        pulls = pulls.filter(
          (p) => sameIdentity(p.authorUniqueName, prAuthor) || viewerAssignment(p.reviewers, prAuthor) !== undefined,
        );
      }
      const closedPullRequests = await this.recentlyClosed(viewer);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          // Threads and labels are paid for every pulse: nothing on the cheap
          // list payload covers either, and gating a read on a token that does
          // not cover it is how a cache starts lying. The policy evaluations —
          // the third of the three — are gated, and read *after* the threads
          // because the thread fingerprint is part of what covers them. That
          // costs one extra round trip on a miss and none at all on a hit.
          const [threads, labels] = await Promise.all([
            api.listPullThreads(p.pullRequestId),
            api.listPullLabels(p.pullRequestId),
          ]);
          const policyEvals = await this.policyEvaluations(
            p,
            threads,
            hydrationMaxAgeMs(plan, prReadRef(p.pullRequestId)),
          );
          this.mergeCommits.set(p.pullRequestId, p.lastMergeSourceCommit);
          const reviewThreads = buildReviewThreads(threads, ourReplyRefs(this.opts.sentReplies, p.pullRequestId));
          const pr: PullRequest = {
            id: `pr_${p.pullRequestId}`,
            number: p.pullRequestId,
            title: p.title,
            branch: p.branch,
            baseBranch: p.baseBranch,
            // The commit the policies above evaluated against — what tells a check
            // that was fixed from one that flaked (`src/knowledge/noticeDesk.ts`).
            // Azure reports it as `lastMergeSourceCommit`, which is also what a
            // completion has to quote back, so an empty string means "not reported"
            // here exactly as it does there.
            ...(p.lastMergeSourceCommit ? { headSha: p.lastMergeSourceCommit } : {}),
            ciStatus: aggregatePolicyCiStatus(policyEvals),
            ciChecks: listPolicyCiChecks(policyEvals, this.opts.policyChecks),
            ciChecksWithheld: policyCiDetailWithheld(policyEvals, this.opts.policyChecks),
            unresolvedComments: threadComments(reviewThreads),
            reviewThreads,
            approved: computeApproved(p.reviewers.map((r) => r.vote)),
            mergeableState: normalizeMergeState(p.mergeStatus, p.isDraft),
            merged: false, // active PRs only; a completed PR drops out of the list
            state: 'open',
            labels,
            url: p.url,
          };
          // The name a person goes by, with the UPN behind it: Azure leaves
          // `displayName` empty on some identities, and an assignment row that
          // named nobody is the wording this field exists to fix. Neither means
          // the sentence simply drops the name.
          const author = p.authorDisplayName || p.authorUniqueName;
          if (author !== '') pr.author = author;
          // Whose pull request this is, against `viewer` and never `prAuthor`, for
          // the reason the assignment below is: the filter also admits the pull
          // requests a colleague put the operator on as a reviewer, so reading it as
          // ownership is what had the fleet working another team's review threads.
          // Compared on the UPN — `displayName` is a label and two people may share
          // one. → `src/prOwnership.ts`
          if (viewer !== '' && p.authorUniqueName !== '') pr.viewerAuthored = sameIdentity(p.authorUniqueName, viewer);
          // Against `viewer` — who the credential *is* — and never against
          // `prAuthor`, which is a filter and is unset the moment a project turns
          // `ownWorkOnly` off. Read the other way round, turning the filter off
          // would take the assignment with it.
          const assignment = viewerAssignment(p.reviewers, viewer);
          if (assignment !== undefined) pr.viewerAssignment = assignment;
          // Only ever `true`: an operator who has not voted, and one Azure lists
          // no entry for at all, are the same silence, and writing `false` for it
          // would assert a verdict nobody gave.
          if (viewerApproved(p.reviewers, viewer)) pr.viewerApproved = true;
          // Only assert (not-)mergeable when Azure reports a concrete state; leave
          // it unknown while it is still computing ('queued'/'notSet'), mirroring
          // GitHub's tri-state `mergeable`.
          const mergeable = mergeableFromStatus(p.mergeStatus);
          if (mergeable !== undefined) pr.mergeable = mergeable;
          return pr;
        }),
      );

      // A PR that has left the active set (or the author filter) is never asked
      // about again. Done after the fan-out so this pulse's hits survive to be read.
      this.policyReadings.retain(pulls.map((p) => p.pullRequestId));
      this.lastGood = pullRequests;
      this.lastGoodClosed = closedPullRequests;
      return { pullRequests, closedPullRequests };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      // No successful read yet — nothing to degrade to. An empty slice would make
      // every open PR look closed; fail the pulse instead.
      if (this.lastGood === null) throw err;
      return { pullRequests: this.lastGood!, closedPullRequests: this.lastGoodClosed!, stale: true };
    }
  }

  /**
   * This pull request's branch-policy evaluations — from the network, or from
   * the last fan-out when nothing that could have moved them has moved.
   *
   * The subtle one. A pull request's head commit is **not** a token for its
   * policy evaluations: a build completing changes the evaluation and nothing
   * else, which is exactly the transition the harness exists to notice. So a
   * reading is only reused when both halves hold.
   *
   * *Settled* — every enabled build/status evaluation has reached a verdict
   * (`approved` / `rejected` / `notApplicable`) and none is `isExpired`. While
   * any of them is `queued`, `running`, expired or unreported, the answer is
   * expected to change without anything else about the PR changing, and the read
   * is always paid for. This is the rule that keeps a running build from being
   * cached as pending forever.
   *
   * *Unmoved* — the token below covers, field by field, what a settled
   * evaluation can still be a function of:
   *
   * - `lastMergeSourceCommit`, `mergeStatus`, `isDraft` — the build and status
   *   policies re-evaluate when the head moves.
   * - the reviewer votes, off the same list payload the filter already reads —
   *   the required/minimum-reviewer policies.
   * - a fingerprint of the threads fetched a moment ago — the comment-resolution
   *   policy, whose whole input is those threads.
   *
   * What it does **not** cover is stated plainly rather than papered over: a
   * work-item-linking policy (its input is a relation written on the work item,
   * which this capability never reads), a merge-strategy policy, an unrecognised
   * policy type, and any policy an administrator adds, retires or reconfigures.
   * Those are covered only by the age backstop — `maxAgeMs`, which is what this
   * pull request's [lane](../../world/readPlan.ts) allows it: a minute for one the
   * fleet is working, ten for one nothing has touched. The backstop is the whole
   * of their freshness, which is why an operator raising it is raising how long an
   * administrator's policy change can go unnoticed.
   */
  private async policyEvaluations(p: AzPull, threads: AzThread[], maxAgeMs: number): Promise<AzPolicyEvaluation[]> {
    const token = policyReuseToken(p, threads);
    const hit = this.policyReadings.get(p.pullRequestId, maxAgeMs);
    if (hit !== undefined && hit.token === token && policyEvalsSettled(hit.evals)) return hit.evals;
    const evals = await this.opts.api.listPolicyEvaluations(p.pullRequestId);
    this.policyReadings.set(p.pullRequestId, { token, evals });
    return evals;
  }

  /**
   * The PRs that left the active set inside the retention window, in the same
   * domain shape as an active one — minus every signal only an *open* PR has
   * (policy evaluations, threads, labels), which is what keeps this one request.
   */
  private async recentlyClosed(viewer: string): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPullRequests(since);
    return closed
      .filter((p) => !prAuthor || p.authorUniqueName === prAuthor)
      .map((p) => {
        const pr = mapClosedPull(p);
        // Answered on the closed list too, because the branch reap acts on it: a
        // colleague's completed pull request whose branch the harness deleted is
        // the same mistake as a rename, and irreversible.
        if (viewer !== '' && p.authorUniqueName !== '') pr.viewerAuthored = sameIdentity(p.authorUniqueName, viewer);
        return pr;
      });
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    // Azure threads a reply under a thread; the fake/domain `commentId` carries the
    // thread id. A null commentId means "no thread to reply under" → open a new one.
    const ref =
      input.commentId !== null
        ? await api.createThreadReply(input.prNumber, Number(input.commentId), 1, input.body)
        : await api.createThread(input.prNumber, input.body);
    // The id, when Azure named one, is what the next thread read will call this
    // comment — the whole of how a reply is recognised as the fleet's. The URL
    // stays the audit line's reference.
    return { ok: true, ref: ref.url, ...(ref.id === undefined ? {} : { commentRef: String(ref.id) }) };
  }

  /**
   * Mark a comment thread resolved. `commentId` carries the **thread** id here,
   * as it does for a reply, and `fixed` is the status the resolved arm of
   * {@link buildUnresolvedComments} already reads — so a thread resolved this way
   * settles on the next poll exactly as one a reviewer closed themselves.
   */
  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    await this.opts.api.setThreadStatus(input.prNumber, Number(input.commentId), 'fixed');
    return { ok: true, ref: input.commentId };
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

  /**
   * Close a pull request that will not be merged — `abandoned` on Azure, which is
   * the same word the closed-window read maps to `closed`. Unlike {@link mergePr}
   * it needs no remembered head commit: Azure asks for one only to complete, so an
   * abandon works on a pull request this process never snapshotted.
   */
  async closePr(input: PrCloseInput): Promise<SendResult> {
    await this.opts.api.abandonPullRequest(input.prNumber);
    return { ok: true, ref: `pr:${input.prNumber}` };
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

  async deleteBranch(input: BranchDeleteInput): Promise<SendResult> {
    const deleted = await this.opts.api.deleteBranch(input.branch);
    // Already gone is success — see `ActionSink.deleteBranch`. On Azure that is the
    // rarer case (it has no delete-on-merge setting), but a branch a human deleted
    // by hand reaches here exactly the same way.
    return { ok: true, ref: deleted ? input.branch : `${input.branch} (already absent)` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }

  /**
   * Queue a fresh run of an **expired** build-validation policy (issue #395) — the
   * gate rule `pr-ci-gate` used to spend a code agent, a worktree and a cold read
   * of the repository on, to do the one thing the harness already knew was needed.
   *
   * The evaluation is requeued rather than the build definition queued. A build
   * started against the definition is not attached to *this* pull request's
   * evaluation, so the policy would stay expired while a build ran — a gate that
   * looks cleared for one pulse and is not.
   *
   * **A 200 is not a requeue.** Azure answers with the evaluation record whether
   * or not it restarted anything, and a record that comes back still `isExpired`
   * is one it declined — a token without **Build (execute)**, a definition it
   * cannot queue. Answering `ok: false` there is what sends the gate back to the
   * agent on the next pulse instead of leaving it waiting on a build nobody
   * started. A call that *fails* throws, and the executor records that as its own
   * outcome.
   */
  async requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult> {
    const res = await this.opts.api.requeuePolicyEvaluation(input.requeueRef);
    if (res.isExpired === true) return { ok: false };
    return { ok: true, ref: `${input.check} (${res.status ?? 'queued'})` };
  }

  /**
   * What the failed build actually reported: the timeline's own `issues` where
   * the steps raised any, the failing step's log tail where they did not.
   *
   * The timeline is one request and usually the whole answer — Azure extracts a
   * failing task's errors into it, so most builds need no log read at all. Only
   * **task** records are considered: a failed Job or Stage is an aggregate of the
   * task that actually broke, and reporting both would tell the agent the same
   * thing two or three times at the top of its budget.
   *
   * Isolated and silent per check, for the reason the GitHub reader states. The
   * failure worth calling out here is a **PAT without Build (read)** scope: the
   * work-item and code scopes an operator naturally grants do not cover
   * `_apis/build`, so this 403s while every other read succeeds. It records and
   * moves on, and the dispatch goes out exactly as it did before.
   */
  async readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]> {
    const found: CiFailureEvidence[] = [];
    for (const check of checks) {
      const buildId = Number(check.evidenceRef);
      if (!Number.isInteger(buildId) || buildId <= 0) continue;
      try {
        const timeline = await this.opts.api.getBuildTimeline(buildId);
        const failedTasks = timeline.filter((r) => r.type.toLowerCase() === 'task' && r.result === 'failed');
        const errors = failedTasks.flatMap((r) =>
          r.issues.filter((i) => i.type.toLowerCase() === 'error').map((i) => taskIssueLine(r, i.message)),
        );
        if (errors.length > 0) {
          found.push({ check: check.name, kind: 'errors', lines: errors });
          continue;
        }
        const withLog = failedTasks.find((r) => r.logId !== null);
        if (!withLog?.logId) continue;
        const all = (await this.opts.api.getBuildLog(buildId, withLog.logId)).filter((l) => l.trim() !== '');
        const tail = all.slice(-EVIDENCE_LOG_TAIL_LINES);
        if (tail.length === 0) continue;
        found.push({
          check: check.name,
          kind: 'log',
          lines: tail.map(stripLogTimestamp),
          ...(all.length > tail.length ? { droppedBefore: all.length - tail.length } : {}),
        });
      } catch (err) {
        this.opts.errors?.record({
          source: 'provider',
          message: `${this.id} could not read CI evidence for "${check.name}" on PR #${prNumber}: ${(err as Error).message}`,
          detail:
            'The CI-fix agent was dispatched without the failing output; it will reproduce the failure instead. ' +
            'A 403 here usually means the token lacks Build (read) scope.',
        });
      }
    }
    return found;
  }
}

/** One timeline error, named by the step that raised it — "which task broke" is half the answer. */
function taskIssueLine(record: AzTimelineRecord, message: string): string {
  return `${record.name}: ${message.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * Drop the ISO timestamp Azure prefixes to every build-log line — 29 characters
 * on every line of an excerpt with a character budget.
 */
function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
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
    ...(p.mergeCommitSha === null ? {} : { mergeCommitSha: p.mergeCommitSha }),
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
 * Everything about a pull request that a **settled** branch-policy evaluation
 * can still be a function of, folded into one comparable string.
 *
 * Read off payloads the pulse has already paid for — the active-PR list and the
 * threads — so building it costs no request. Order-insensitive on both lists:
 * Azure does not promise a stable order for either, and a token that moved
 * because two reviewers swapped places would gate nothing.
 */
function policyReuseToken(p: AzPull, threads: AzThread[]): string {
  const reviewers = p.reviewers.map((r) => `${r.uniqueName}:${r.vote}:${r.isRequired}`).sort();
  // The thread's own status and how many comments it carries: between them, the
  // whole of what a comment-resolution policy evaluates. The bodies are not part
  // of it — an edited comment does not resolve or unresolve a thread.
  const threadFingerprint = threads.map((t) => `${t.id}:${t.status ?? ''}:${t.comments.length}`).sort();
  return JSON.stringify([p.lastMergeSourceCommit, p.mergeStatus, p.isDraft, reviewers, threadFingerprint]);
}

/**
 * Has every automated policy on this pull request reached a verdict?
 *
 * The gate on reusing a cached evaluation list. `queued` and `running` are the
 * obvious unsettled states; `isExpired` is the third, and the one worth naming —
 * an expired build-validation evaluation is `queued` with nothing in flight, and
 * becomes an ordinary running one the moment a build is queued for the current
 * head, which is a transition no token on the pull request reports. A `null`
 * status counts as unsettled too: Azure reports both "no verdict yet" and "does
 * not apply" thinly, and reading the ambiguous one as settled would be the
 * expensive mistake.
 *
 * Scoped to the **build and status** kinds because they are the ones whose
 * verdict arrives on its own, from a machine, with nothing about the pull request
 * changing. A reviewer or comment policy only moves when a person does something
 * the reuse token already sees.
 */
export function policyEvalsSettled(evals: AzPolicyEvaluation[]): boolean {
  for (const e of evals) {
    if (!e.isEnabled) continue;
    const kind = policyKindOf(e.typeId);
    if (kind !== 'build' && kind !== 'status') continue;
    if (e.isExpired === true) return false;
    if (e.status !== 'approved' && e.status !== 'rejected' && e.status !== 'broken' && e.status !== 'notApplicable') {
      return false;
    }
  }
  return true;
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
 * and rule `pr-ci-failing` reads that through `ciNeedsAttention`. Reviewer / comment /
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
 *
 * A policy with *two* names carries the second as an alias, which a `ci.checks`
 * glob matches as readily as the name — the status policy's case, where the label
 * on the pull request page is not the key the check is stored under.
 *
 * An **expired** build-validation evaluation carries `expired: true` beside its
 * `pending` status rather than a status of its own. It is genuinely pending —
 * no verdict, and the moment a build is queued it becomes an ordinary one — so
 * mapping it to `failing` would have {@link aggregatePolicyCiStatus} claim the
 * pull request cannot merge over a build that has not run, and would send an
 * agent the CI-fix prompt to investigate a failure that does not exist. What
 * changes is one thing: `classifyWatchedChecks` watches it with no `ci.checks`
 * rule naming it, so rule `pr-ci-gate` dispatches. → `src\ci\ciPolicy.ts`
 */
/**
 * Did `off` drop every check this build's policies could have reported?
 *
 * The companion to {@link listPolicyCiChecks}, and the reason it is needed is
 * that the list it returns comes back **empty** — which is the one input every
 * layer below reads as *the provider reported no per-check detail*. Both fallback
 * arms (`ciNeedsAttention`, `classifyCiFailures`) exist for a provider that has
 * nothing else to answer from; under `off` the provider had the detail and was
 * told not to emit it. Configured silence and unreported silence are opposite
 * instructions, and once the array is empty they are indistinguishable.
 *
 * Only true when something was actually dropped *and* nothing survived: a build
 * that reports one `check` kind beside an `off` one already carries detail, so
 * neither fallback arm is reached and the flag would say nothing.
 *
 * Scoped to what {@link listPolicyCiChecks} would have emitted — enabled, with a
 * status that maps — so a disabled policy, which is stale noise either way, does
 * not make an unconfigured harness look configured.
 */
function policyCiDetailWithheld(evals: AzPolicyEvaluation[], modes?: PolicyCheckModes): boolean {
  let dropped = false;
  for (const e of evals) {
    if (!e.isEnabled) continue;
    if (!checkStatusOf(e.status)) continue;
    if (policyCheckMode(policyKindOf(e.typeId), modes) === 'off') dropped = true;
    else return false;
  }
  return dropped;
}

export function listPolicyCiChecks(evals: AzPolicyEvaluation[], modes?: PolicyCheckModes): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const e of evals) {
    if (!e.isEnabled) continue;
    const mode = policyCheckMode(policyKindOf(e.typeId), modes);
    if (mode === 'off') continue;
    const status = checkStatusOf(e.status);
    if (!status) continue;
    const check: CiCheck = { name: e.displayName, status, blocking: e.isBlocking };
    // Only a failing build has evidence to fetch. A status policy carries no
    // build id at all — it names an external system Azure has no log for — and a
    // pending build's last output is about commits this branch has moved past.
    if (status === 'failing' && e.buildId !== undefined) check.evidenceRef = String(e.buildId);
    // Only when the provider reported one: an empty array on every other check
    // would be a field that reads as meaningful and never is.
    if (e.displayAliases && e.displayAliases.length > 0) check.aliases = [...e.displayAliases];
    if (mode === 'advisory') check.advisory = true;
    // An expired evaluation is a *pending* one that nothing is working on, so the
    // flag rides beside the status rather than replacing it. Guarded on `pending`
    // because the flag only says anything about a check that has not resolved:
    // whatever `isExpired` reads beside an `approved` or `rejected` status, the
    // verdict is in and there is nothing left to wait for.
    if (status === 'pending' && e.isExpired) {
      check.expired = true;
      // The handle the harness clears the gate with, carried only where it means
      // anything: an expired evaluation is the one state a requeue answers, and
      // the flag and the handle therefore travel together. An evaluation that came
      // back without an id leaves it unset, which reads downstream as "nothing to
      // queue directly" and puts the gate back on the agent it always had.
      if (e.evaluationId) check.requeueRef = e.evaluationId;
    }
    checks.push(check);
  }
  return checks;
}

/**
 * A policy evaluation status as a {@link CiCheck} status, or null for no signal.
 *
 * `queued` and `running` collapse onto `pending` because the difference is about
 * the build agent's queue, not about the pull request: both mean a verdict is
 * coming and nothing is owed by anyone. Whether one is *actually* coming is a
 * separate question the status cannot answer — `context.isExpired` does, and is
 * carried as a flag on the check by {@link listPolicyCiChecks} rather than as a
 * fourth status here, so every merge-facing reader of {@link CiStatus} is
 * untouched by it.
 */
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
/**
 * Whether **this** operator was personally asked to review, and how firmly.
 *
 * Two things are deliberately not an assignment. A **group** entry is one
 * (`isContainer`): Azure lists a team exactly as it lists a person, so a policy
 * naming a team would otherwise put every pull request in the project on every
 * member's queue — the one way to make a queue stop being read.
 * And an entry with no `uniqueName` is one: Azure reports group identities as
 * `vstfs:///…` descriptors, so a blank or a descriptor can never match a UPN and
 * must not be allowed to match an unset `userId` either.
 *
 * Case-insensitive because a UPN is, and an operator who writes their own address
 * in a config file with different capitalisation from the directory's is not
 * telling the harness about a different person — they would simply see the
 * feature do nothing.
 */
function viewerAssignment(reviewers: readonly AzReviewer[], viewer: string): ViewerAssignment | undefined {
  if (viewer === '') return undefined;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  if (mine === undefined) return undefined;
  return mine.isRequired ? 'reviewer-required' : 'reviewer-optional';
}

/**
 * Whether **this** operator's own vote on the pull request is an approving one —
 * Azure's 10 (approved) or 5 (approved with suggestions), the same two
 * {@link computeApproved} counts, asked of one reviewer instead of all of them.
 *
 * Their vote, never the fold: a pull request somebody else approved is still
 * waiting on the review this operator was asked for, and reading the aggregate
 * here would clear their row on a colleague's answer.
 */
function viewerApproved(reviewers: readonly AzReviewer[], viewer: string): boolean {
  if (viewer === '') return false;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  return mine !== undefined && mine.vote >= 5;
}

/** Two Azure identities, compared as the directory means them: UPNs, case-insensitively. */
function sameIdentity(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}

export function computeApproved(votes: number[]): boolean {
  if (votes.some((v) => v < 0)) return false;
  return votes.some((v) => v >= 5);
}

/**
 * Surface one {@link PrReviewThread} per PR comment thread, keyed on the thread
 * id — the provider's whole reading of a pull request's review, from which
 * `unresolvedComments` is derived by {@link threadComments} rather than built
 * beside it.
 *
 * A thread is `resolved` once Azure marks it so (fixed/closed/wontFix/byDesign)
 * and `answered` when the latest **reply** in it is one the harness recorded
 * sending — the
 * network-native analogue of the fake's `markCommentHandled`, so the
 * deterministic loop settles one poll after a reply is posted. Both fold to
 * `handled` for the rules; they are kept apart because "the reviewer closed this"
 * and "we answered and nobody has come back" are different news for a person.
 * System comments (status changes, etc.) are ignored.
 *
 * **The reply arm is a record, not an identity test**, and `ourReplies` carries
 * it: the ids of the comments this harness actually posted (`PrReplyStore`). The
 * PAT the harness authenticates as is the operator's own on a single-operator
 * deployment, so asking whether the newest reply's author is `viewer` answered
 * yes for the operator's own follow-up on their own thread — which flipped it to
 * `answered`, folded to `PrComment.handled`, and dropped the comment before rule
 * `pr-review-comment` ever saw it. Position was not enough either: a reviewer
 * replies under their own root too. Only the record can tell the two apart, and it
 * is the same record the GitHub provider reads, so the two cannot disagree about a
 * thread.
 *
 * A one-comment thread has no reply and is never `answered` by this arm. An empty
 * `ourReplies` — no record, or a reply from before the record existed — leaves
 * every thread open, which is the safe direction: a re-dispatch is visible and
 * cheap, a dropped review is neither.
 *
 * Azure's own `resolved` status is unaffected and stays the primary arm — it is a
 * real verdict from the reviewer rather than an inference about who spoke last.
 */
export function buildReviewThreads(threads: AzThread[], ourReplies: ReadonlySet<string> = new Set()): PrReviewThread[] {
  const RESOLVED: ReadonlySet<string> = new Set(['fixed', 'closed', 'wontFix', 'byDesign']);
  const out: PrReviewThread[] = [];
  for (const thread of threads) {
    const comments = thread.comments.filter((c) => c.commentType !== 'system');
    const root = comments[0];
    if (!root) continue; // a purely-system thread carries no reviewer signal
    const replies = comments.slice(1);
    const lastReply = replies.length > 0 ? replies[replies.length - 1]! : null;
    const built: PrReviewThread = {
      id: String(thread.id),
      author: root.authorUniqueName,
      body: root.content,
      state: threadState({
        resolved: thread.status !== null && RESOLVED.has(thread.status),
        answered: lastReply !== null && ourReplies.has(String(lastReply.id)),
      }),
      replies: replies.map((c) => ({
        id: String(c.id),
        author: c.authorUniqueName,
        body: c.content,
        // The record of what the harness sent, never the author. Azure's PAT is
        // the operator's own on a single-operator deployment, so an identity test
        // badged their own replies as the fleet's and settled the thread under
        // them — see `PrReplyStore`.
        ours: ourReplies.has(String(c.id)),
      })),
    };
    // Where the thread hangs, when Azure reported it — a thread on the pull
    // request rather than on the diff carries neither, and is drawn as such.
    if (thread.filePath !== undefined && thread.filePath !== null) built.path = thread.filePath.replace(/^\//, '');
    if (thread.line !== undefined && thread.line !== null) built.line = thread.line;
    out.push(built);
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
