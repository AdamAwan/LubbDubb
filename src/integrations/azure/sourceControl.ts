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
  /** Azure target identity, for building web URLs. Unset = ref resolution returns null, same contract `GitHubSourceControlIntegration` has. */
  organization?: string;
  project?: string;
  repository?: string;
  /** Only surface PRs opened by this uniqueName. Unset = all active PRs. */
  prAuthor?: string;
  /** Which branch-policy kinds become CI checks, and at what mode. Unset = the defaults. */
  policyChecks?: PolicyCheckModes;
  /** How far back to look for PRs that have left the active set (`config.closedPrWindowMs`). 0 / unset skips the lookup entirely. */
  closedPrWindowMs?: number;
  /** Injectable clock, so the retention window is testable without waiting for one. */
  now?: () => number;
  /**
   * The record of which replies this harness actually sent — what decides whether a
   * reply is the fleet's. One derivation in `src/prThreads.ts`, so the two providers
   * cannot disagree. Unset means no record, and every thread reads as unanswered.
   * → `docs/spec/07-pull-requests.md#review-threads`
   */
  sentReplies?: SentPrReplies;
}

/**
 * The real `sourceControl` provider for Azure DevOps Repos: reads pull requests and
 * merge-readiness signals from the REST API, and posts replies / completes through it.
 * A drop-in for {@link GitHubSourceControlIntegration} over the same seams, but
 * network-backed, so it is not `Injectable`.
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
   * The branch-policy evaluations from the last fan-out, beside the token they were
   * read against — the one per-PR read this provider can skip. Not a degradation path
   * like {@link lastGood}: a hit is a current reading that cost no request.
   */
  private readonly policyReadings = new HydrationCache<{ token: string; evals: AzPolicyEvaluation[] }>();

  constructor(private readonly opts: AzureSourceControlOpts) {}

  /**
   * Resolves every ref shape, work items included, not just the ones this capability
   * owns: `CompositeConnector.resolveRefUrl` routes to the first resolvable
   * integration, and `sourceControl` is built first.
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
      // "Your work" is what you opened or what somebody asked you for — narrowed to
      // authorship alone, a PR naming the operator as reviewer never enters the world.
      if (prAuthor) {
        pulls = pulls.filter(
          (p) => sameIdentity(p.authorUniqueName, prAuthor) || viewerAssignment(p.reviewers, prAuthor) !== undefined,
        );
      }
      const closedPullRequests = await this.recentlyClosed(viewer);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          // Threads and labels are paid for every pulse — nothing on the list payload
          // covers either. Policy evaluations are read after, since the thread
          // fingerprint covers them.
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
            // The commit the policies evaluated against — tells a fixed check from a
            // flaked one. Empty string means "not reported".
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
          // `displayName` empty on some identities.
          const author = p.authorDisplayName || p.authorUniqueName;
          if (author !== '') pr.author = author;
          // Ownership is answered against `viewer`, never `prAuthor`, which also
          // admits PRs a colleague put the operator on as reviewer. UPN-compared.
          // → `src/prOwnership.ts`
          if (viewer !== '' && p.authorUniqueName !== '') pr.viewerAuthored = sameIdentity(p.authorUniqueName, viewer);
          const assignment = viewerAssignment(p.reviewers, viewer);
          if (assignment !== undefined) pr.viewerAssignment = assignment;
          // Only ever `true`: `false` would assert a verdict nobody gave.
          if (viewerApproved(p.reviewers, viewer)) pr.viewerApproved = true;
          // Only assert (not-)mergeable on a concrete state; leave it unknown while
          // Azure is still computing ('queued'/'notSet').
          const mergeable = mergeableFromStatus(p.mergeStatus);
          if (mergeable !== undefined) pr.mergeable = mergeable;
          return pr;
        }),
      );

      // A PR that has left the active set is never asked about again.
      this.policyReadings.retain(pulls.map((p) => p.pullRequestId));
      this.lastGood = pullRequests;
      this.lastGoodClosed = closedPullRequests;
      return { pullRequests, closedPullRequests };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      // No successful read yet: an empty slice would make every open PR look closed.
      if (this.lastGood === null) throw err;
      return { pullRequests: this.lastGood!, closedPullRequests: this.lastGoodClosed!, stale: true };
    }
  }

  /**
   * This pull request's branch-policy evaluations — from the network, or from the last
   * fan-out when nothing that could have moved them has moved. A head commit is not a
   * token on its own: a build completing changes the evaluation. So a reading is
   * reused only when both settled and unmoved hold.
   *
   * Settled: every enabled build/status evaluation has a verdict and none is
   * `isExpired`. Unmoved: the token covers `lastMergeSourceCommit`, `mergeStatus`,
   * `isDraft`, the reviewer votes and a fingerprint of the threads. It does not cover
   * a work-item-linking or merge-strategy policy or any admin-changed policy — those
   * rely only on the age backstop `maxAgeMs`.
   */
  private async policyEvaluations(p: AzPull, threads: AzThread[], maxAgeMs: number): Promise<AzPolicyEvaluation[]> {
    const token = policyReuseToken(p, threads);
    const hit = this.policyReadings.get(p.pullRequestId, maxAgeMs);
    if (hit !== undefined && hit.token === token && policyEvalsSettled(hit.evals)) return hit.evals;
    const evals = await this.opts.api.listPolicyEvaluations(p.pullRequestId);
    this.policyReadings.set(p.pullRequestId, { token, evals });
    return evals;
  }

  /** The PRs that left the active set inside the retention window, minus every signal only an open PR has, in one request. */
  private async recentlyClosed(viewer: string): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPullRequests(since);
    return closed
      .filter((p) => !prAuthor || p.authorUniqueName === prAuthor)
      .map((p) => {
        const pr = mapClosedPull(p);
        // Answered here too, because the branch reap acts on this list and deleting
        // a colleague's branch is irreversible.
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
    // The id, when Azure named one, is how a reply is recognised as the fleet's on
    // the next read; the URL stays the audit line's reference. Thread rides beside it.
    const threadRef =
      input.commentId !== null ? input.commentId : ref.threadId === undefined ? undefined : String(ref.threadId);
    return {
      ok: true,
      ref: ref.url,
      ...(ref.id === undefined ? {} : { commentRef: String(ref.id) }),
      ...(threadRef === undefined ? {} : { threadRef }),
    };
  }

  /** Mark a comment thread resolved. `commentId` carries the thread id here, as for a reply. */
  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    await this.opts.api.setThreadStatus(input.prNumber, Number(input.commentId), 'fixed');
    return { ok: true, ref: input.commentId };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const commit = this.mergeCommits.get(input.prNumber);
    if (!commit) {
      // Never snapshotted, so the head commit Azure requires is unknown. Surface it
      // rather than send a request Azure will reject.
      throw new Error(`no known merge commit for PR ${input.prNumber}; snapshot it before merging`);
    }
    const result = await this.opts.api.completePullRequest(input.prNumber, commit, input.method);
    const ok = result.status === 'completed' || result.status === 'queued';
    return { ok, ref: result.status };
  }

  /** Close a pull request that will not be merged — `abandoned` on Azure. Needs no remembered head commit, unlike {@link mergePr}. */
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
    // Already gone is success — see `ActionSink.deleteBranch`.
    return { ok: true, ref: deleted ? input.branch : `${input.branch} (already absent)` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }

  /**
   * Queue a fresh run of an expired build-validation policy, sparing rule
   * `pr-ci-gate` a code agent and a worktree. The evaluation is requeued, never the
   * build definition — a build queued against the definition would not attach to
   * this evaluation, so the policy would stay expired while it ran.
   *
   * A 200 is not a requeue: Azure answers with the record whether or not it
   * restarted anything, so one still `isExpired` was declined — answer `ok: false`
   * and send the gate back to the agent. A call that fails throws.
   */
  async requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult> {
    const res = await this.opts.api.requeuePolicyEvaluation(input.requeueRef);
    if (res.isExpired === true) return { ok: false };
    return { ok: true, ref: `${input.check} (${res.status ?? 'queued'})` };
  }

  /**
   * What the failed build reported: the timeline's own `issues` where steps raised
   * any, the failing step's log tail where they did not. Only task records count — a
   * failed Job or Stage aggregates the task that broke.
   *
   * Isolated and silent per check. The failure worth naming is a PAT without Build
   * (read) scope: this 403s while every other read succeeds, and the dispatch goes
   * out as before.
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

/** Drop the ISO timestamp Azure prefixes to every build-log line — 29 characters on every line of an excerpt with a character budget. */
function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

/** A completed/abandoned Azure PR as the world models it. CI and comments are blanked rather than fetched: nothing acts on a closed PR. */
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
  // A draft cannot be merged regardless of conflicts — blocked, so the harness
  // surfaces it and never auto-acts.
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
 * concrete, everything else is "still computing" → leave it undefined rather than
 * asserting not-mergeable.
 */
export function mergeableFromStatus(mergeStatus: string): boolean | undefined {
  if (mergeStatus === 'succeeded') return true;
  if (mergeStatus === 'conflicts') return false;
  return undefined;
}

/**
 * Everything a settled branch-policy evaluation can still be a function of, folded
 * into one comparable string. Read off payloads the pulse already paid for, so it
 * costs no request. Order-insensitive on both lists — Azure promises no stable order.
 */
function policyReuseToken(p: AzPull, threads: AzThread[]): string {
  const reviewers = p.reviewers.map((r) => `${r.uniqueName}:${r.vote}:${r.isRequired}`).sort();
  // Status and comment count are the whole of what a comment-resolution policy
  // evaluates; bodies are not — an edit does not resolve or unresolve a thread.
  const threadFingerprint = threads.map((t) => `${t.id}:${t.status ?? ''}:${t.comments.length}`).sort();
  return JSON.stringify([p.lastMergeSourceCommit, p.mergeStatus, p.isDraft, reviewers, threadFingerprint]);
}

/**
 * Has every automated policy on this pull request reached a verdict? The gate on
 * reusing a cached evaluation list. `isExpired` counts as unsettled, and so does a
 * `null` status, which Azure uses ambiguously. Scoped to the build and status kinds —
 * a reviewer or comment policy only moves when the reuse token already sees it.
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
 * Fold a PR's branch-policy evaluations into one {@link CiStatus} — the authoritative
 * "are the required checks passing?" signal. Deliberately frozen at enabled +
 * blocking + build/status, with no configuration reaching it: nothing an operator
 * widens may claim a PR cannot merge when Azure would complete it (widening happens
 * in {@link listPolicyCiChecks} instead). Failing wins, else pending, else passing,
 * else `unknown`.
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
 * Did `off` drop every check this build's policies could have reported? The
 * companion to {@link listPolicyCiChecks}: an empty check list normally means the
 * provider had no per-check detail, but under `off` the provider had detail and was
 * told not to emit it — indistinguishable once the array is empty. True only when
 * something was dropped and nothing survived.
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

/**
 * Every policy evaluation the operator asked to see, kept individually so per-check
 * policy can act on which one failed. Optional (non-blocking) policies are included
 * carrying `blocking: false`. A disabled policy is dropped whatever its mode.
 *
 * An expired build-validation evaluation carries `expired: true` beside its `pending`
 * status, never a status of its own — mapping it to `failing` would have
 * {@link aggregatePolicyCiStatus} claim the PR cannot merge over a build that has not
 * run. `classifyWatchedChecks` watches it instead, so rule `pr-ci-gate` dispatches.
 * → `src/ci/ciPolicy.ts`
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
    // Only a failing build has evidence to fetch: a status policy carries no build
    // id, and a pending build's last output is about commits already moved past.
    if (status === 'failing' && e.buildId !== undefined) check.evidenceRef = String(e.buildId);
    // Only when the provider reported one, so the field is never a meaningless [].
    if (e.displayAliases && e.displayAliases.length > 0) check.aliases = [...e.displayAliases];
    if (mode === 'advisory') check.advisory = true;
    // An expired evaluation is a pending one nothing is working on, so the flag
    // rides beside the status, only on `pending` — a resolved verdict has nothing left to wait for.
    if (status === 'pending' && e.isExpired) {
      check.expired = true;
      // The handle the harness clears the gate with, carried only where a requeue
      // means anything. Unset puts the gate back on an agent.
      if (e.evaluationId) check.requeueRef = e.evaluationId;
    }
    checks.push(check);
  }
  return checks;
}

/**
 * A policy evaluation status as a {@link CiCheck} status, or null for no signal.
 * `queued` and `running` collapse onto `pending` — the difference is the build
 * agent's queue, not the pull request. Whether a verdict is coming is `isExpired`,
 * carried as a flag by {@link listPolicyCiChecks} rather than a fourth status here.
 */
function checkStatusOf(status: string | null): CiCheck['status'] | null {
  if (status === 'rejected' || status === 'broken') return 'failing';
  if (status === 'queued' || status === 'running') return 'pending';
  if (status === 'approved') return 'passing';
  // 'notApplicable' / null contribute no signal, exactly as in the fold.
  return null;
}

/**
 * Whether this operator was personally asked to review, and how firmly. Deliberately
 * not an assignment: a group entry (`isContainer`) is excluded, since a policy naming
 * a team would put every PR in the project on every member's queue. Compared case-insensitively.
 */
function viewerAssignment(reviewers: readonly AzReviewer[], viewer: string): ViewerAssignment | undefined {
  if (viewer === '') return undefined;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  if (mine === undefined) return undefined;
  return mine.isRequired ? 'reviewer-required' : 'reviewer-optional';
}

/** Whether this operator's own vote is an approving one (Azure's 10 or 5), asked of one reviewer — never the fold, which would clear their row on a colleague's answer. */
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
 * Surface one {@link PrReviewThread} per PR comment thread, keyed on the thread id.
 * `unresolvedComments` is derived from this by {@link threadComments}, never built
 * beside it. System comments are ignored.
 *
 * A thread is `resolved` once Azure marks it so, and `answered` when its latest reply
 * is one the harness recorded sending — both fold to `handled` for the rules.
 *
 * The reply arm is a record, not an identity test: Azure's PAT is the operator's own
 * on a single-operator deployment, so an identity test would settle the thread under
 * their own follow-up and drop the comment before rule `pr-review-comment` sees it.
 * Same record as the GitHub provider's, so the two cannot disagree. An empty
 * `ourReplies` leaves every thread open, the safe direction.
 * → `docs/spec/07-pull-requests.md#attribution-is-a-record-never-an-identity`
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
        // The record of what the harness sent, never the author — see `PrReplyStore`.
        ours: ourReplies.has(String(c.id)),
      })),
    };
    // Where the thread hangs, when Azure reported it — a thread on the pull request
    // rather than the diff carries neither.
    if (thread.filePath !== undefined && thread.filePath !== null) built.path = thread.filePath.replace(/^\//, '');
    if (thread.line !== undefined && thread.line !== null) built.line = thread.line;
    // Azure's property bag: the only mark surviving on a thread the harness did not
    // post into, and what `review.publishedThreadProperty` matches against.
    if (thread.properties !== undefined && thread.properties !== null && Object.keys(thread.properties).length > 0) {
      built.properties = thread.properties;
    }
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
