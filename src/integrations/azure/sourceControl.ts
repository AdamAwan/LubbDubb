import type { ErrorRecorder } from '../../errorLog.js';
import type {
  BranchDeleteInput,
  CiCheckRequeueInput,
  MergeMethod,
  PrBaseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { CiCheck, CiStatus, MergeableState, PrComment, PullRequest } from '../../types.js';
import { EVIDENCE_LOG_TAIL_LINES, type CiEvidenceTarget, type CiFailureEvidence } from '../../ci/ciEvidence.js';
import type {
  BranchDeleteCapable,
  WorldCapability,
  CiCheckRequeueCapable,
  CiEvidenceCapable,
  Integration,
  PrBaseCapable,
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
import type { AzClosedPull, AzPolicyEvaluation, AzThread, AzTimelineRecord, AzureDevOpsApi } from './azureDevOpsApi.js';
import { azureRefUrl } from './refUrl.js';
import { policyCheckMode, policyKindOf, type PolicyCheckModes } from './policyKinds.js';

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
            // The commit the policies above evaluated against — what tells a check
            // that was fixed from one that flaked (`src/knowledge/noticeDesk.ts`).
            // Azure reports it as `lastMergeSourceCommit`, which is also what a
            // completion has to quote back, so an empty string means "not reported"
            // here exactly as it does there.
            ...(p.lastMergeSourceCommit ? { headSha: p.lastMergeSourceCommit } : {}),
            ciStatus: aggregatePolicyCiStatus(policyEvals),
            ciChecks: listPolicyCiChecks(policyEvals, this.opts.policyChecks),
            ciChecksWithheld: policyCiDetailWithheld(policyEvals, this.opts.policyChecks),
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
      // No successful read yet — nothing to degrade to. An empty slice would make
      // every open PR look closed; fail the pulse instead.
      if (this.lastGood === null) throw err;
      return { pullRequests: this.lastGood!, closedPullRequests: this.lastGoodClosed!, stale: true };
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
export function computeApproved(votes: number[]): boolean {
  if (votes.some((v) => v < 0)) return false;
  return votes.some((v) => v >= 5);
}

/**
 * Surface one {@link PrComment} per PR comment thread, keyed on the thread id. A
 * thread is `handled` once Azure marks it resolved (fixed/closed/wontFix/byDesign)
 * *or* the harness authored the latest **reply** in it — the network-native
 * analogue of the fake's `markCommentHandled`, so the deterministic loop settles
 * one poll after a reply is posted. System comments (status changes, etc.) are
 * ignored.
 *
 * The reply arm reads the thread's *position*, not merely its latest author, for
 * the reason spelled out on the GitHub side: `viewer` is whoever the harness
 * authenticates as, which on a single-operator deployment is the operator, so an
 * unanswered thread they opened themselves read as already handled and their
 * review was dropped before any rule saw it. A one-comment thread has no reply and
 * is therefore never settled by this arm, whoever wrote it.
 *
 * Azure's own `resolved` status is unaffected and stays the primary arm — it is a
 * real verdict from the reviewer rather than an inference about who spoke last.
 */
export function buildUnresolvedComments(threads: AzThread[], viewer: string): PrComment[] {
  const RESOLVED: ReadonlySet<string> = new Set(['fixed', 'closed', 'wontFix', 'byDesign']);
  const out: PrComment[] = [];
  for (const thread of threads) {
    const comments = thread.comments.filter((c) => c.commentType !== 'system');
    const root = comments[0];
    if (!root) continue; // a purely-system thread carries no reviewer signal
    const lastReply = comments.length > 1 ? comments[comments.length - 1]! : null;
    const resolved = thread.status !== null && RESOLVED.has(thread.status);
    out.push({
      id: String(thread.id),
      author: root.authorUniqueName,
      body: root.content,
      handled: resolved || lastReply?.authorUniqueName === viewer,
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
