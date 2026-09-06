import type { ErrorRecorder } from '../../errorLog.js';
import type {
  BranchDeleteInput,
  PrBaseInput,
  PrBaseUpdateInput,
  PrCloseInput,
  PrCreateInput,
  PrLabelInput,
  PrMergeInput,
  PrReplyInput,
  PrThreadResolveInput,
  PrTitleInput,
  SendResult,
} from '../../sink/actionSink.js';
import type { CiCheck, CiStatus, MergeableState, PrReviewThread, PullRequest } from '../../types.js';
import { ourReplyRefs, threadComments, threadState, type SentPrReplies } from '../../prThreads.js';
import { EVIDENCE_LOG_TAIL_LINES, type CiEvidenceTarget, type CiFailureEvidence } from '../../ci/ciEvidence.js';
import type {
  BranchDeleteCapable,
  WorldCapability,
  CiEvidenceCapable,
  Integration,
  PrBaseCapable,
  PrBaseUpdateCapable,
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
  GhAnnotation,
  GhCheckRun,
  GhClosedPull,
  GhCombinedStatus,
  GhPullSummary,
  GhReview,
  GhReviewComment,
  GhReviewThread,
  GitHubApi,
} from './githubApi.js';
import { HydrationCache } from '../hydrationCache.js';
import { hydrationMaxAgeMs, prReadRef, type ReadPlan } from '../../world/readPlan.js';
import { githubRefUrl } from './refUrl.js';

/**
 * The half of a hydrated pull request that costs the four per-PR reads, held
 * against the `updated_at` the list payload reported. Everything else on a
 * {@link PullRequest} comes off the list payload and is never cached.
 */
interface CachedPullDetail {
  /** The token this hydration is valid for. */
  updatedAt: string;
  approved: boolean;
  viewerApproved: boolean;
  reviewThreads: PrReviewThread[];
  mergeable: boolean | null;
  mergeableState: MergeableState;
  merged: boolean;
}

/**
 * The CI half, held against the head SHA rather than `updated_at`: a check run
 * completing does not touch `updated_at`, so gating on it would freeze a red build
 * as green for as long as nobody commented.
 */
interface CachedPullCi {
  headSha: string;
  ciStatus: CiStatus;
  ciChecks: CiCheck[];
}

/**
 * Whether a CI reading is finished with, i.e. safe to reuse while the head SHA
 * holds. `pending` and `unknown` change without any token moving, so both are
 * refetched every pulse.
 */
function ciSettled(status: CiStatus): boolean {
  return status === 'passing' || status === 'failing';
}

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
  /**
   * The record of which replies this harness actually sent — what decides whether
   * a reply is the fleet's. Unset means "no record": every thread reads as
   * unanswered work, never as handled.
   * → `docs/spec/07-pull-requests.md#review-threads`
   */
  sentReplies?: SentPrReplies;
}

/**
 * The real `sourceControl` provider: reads pull requests and the merge-readiness
 * signals from the GitHub API, and posts replies / merges through it. A drop-in for
 * {@link FakeGitHubIntegration} over the same seams, but network-backed, so it is
 * *not* `Injectable`.
 */
export class GitHubSourceControlIntegration
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
    PrBaseUpdateCapable,
    BranchDeleteCapable,
    CiEvidenceCapable,
    RefResolvable
{
  readonly id = 'sourceControl:github';
  readonly capability: WorldCapability = 'sourceControl';

  /** Last successful slice, served on a transient failure so PRs don't flap. */
  private lastGood: PullRequest[] | null = null;
  private lastGoodClosed: PullRequest[] | null = null;

  /**
   * Change-gated hydration, keyed by PR number. **Not** a degradation path: a hit
   * is a current reading, so it never sets `stale`. → {@link HydrationCache}
   */
  private readonly detailCache: HydrationCache<CachedPullDetail>;
  private readonly ciCache: HydrationCache<CachedPullCi>;

  constructor(private readonly opts: GitHubSourceControlOpts) {
    this.detailCache = new HydrationCache(opts.now);
    this.ciCache = new HydrationCache(opts.now);
  }

  async snapshot(plan?: ReadPlan): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerLogin();
      let pulls = await api.listOpenPulls();
      // "Your work" is what you opened **or what somebody handed you**: narrowed to
      // authorship alone, an assigned pull request never enters the world at all and
      // the queue cannot raise it. Costs no extra request.
      if (prAuthor) pulls = pulls.filter((p) => p.authorLogin === prAuthor || p.assigneeLogins.includes(prAuthor));
      const closedPullRequests = await this.recentlyClosed(viewer);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          // One lane per pull request, resolved once: the two caches gate on
          // different tokens, and differing lanes would split a PR across both.
          const maxAgeMs = hydrationMaxAgeMs(plan, prReadRef(p.number));
          const [detail, ci] = await Promise.all([this.pullDetail(p, viewer, maxAgeMs), this.pullCi(p, maxAgeMs)]);
          const pr: PullRequest = {
            id: `pr_${p.number}`,
            number: p.number,
            title: p.title,
            branch: p.branch,
            baseBranch: p.baseBranch,
            // The commit the checks ran against — what tells a fixed check from a
            // flaked one (`src/knowledge/noticeDesk.ts`).
            headSha: p.headSha,
            ciStatus: ci.ciStatus,
            ciChecks: ci.ciChecks,
            unresolvedComments: threadComments(detail.reviewThreads),
            reviewThreads: detail.reviewThreads,
            approved: detail.approved,
            mergeableState: detail.mergeableState,
            merged: detail.merged,
            // Listed as open, so 'open' unless the detail read caught it mid-merge.
            state: detail.merged ? 'merged' : 'open',
            labels: p.labels,
            url: p.url,
          };
          // The login is the only name on the list payload, and what a reviewer is
          // asked by.
          if (p.authorLogin !== '') pr.author = p.authorLogin;
          // Ownership is answered against `viewer`, the identity the token actually
          // is — never `prAuthor`, a filter that also admits assigned PRs, which read
          // as ownership would put the fleet on somebody else's review threads.
          // Absent where GitHub named neither side. → `src/prOwnership.ts`
          if (viewer !== '' && p.authorLogin !== '') pr.viewerAuthored = p.authorLogin === viewer;
          // Only ever `true`: `false` would assert a verdict nobody gave.
          if (detail.viewerApproved) pr.viewerApproved = true;
          // Against `viewer`, never `prAuthor`: that filter is unset the moment a
          // project turns `ownWorkOnly` off, which would take the assignment with it.
          if (viewer !== '' && p.assigneeLogins.includes(viewer)) pr.viewerAssignment = 'assignee';
          // GitHub's tri-state `mergeable`: null means "still computing", so leave
          // it unknown rather than asserting not-mergeable.
          if (detail.mergeable !== null) pr.mergeable = detail.mergeable;
          return pr;
        }),
      );

      // A PR that has left the open set is never hydrated again, so its entries
      // are dead weight from here on.
      const open = pulls.map((p) => p.number);
      this.detailCache.retain(open);
      this.ciCache.retain(open);

      this.lastGood = pullRequests;
      this.lastGoodClosed = closedPullRequests;
      return { pullRequests, closedPullRequests };
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} snapshot failed: ${(err as Error).message}`,
      });
      // With no successful read yet, an empty slice is a fabricated world, not a
      // stale one — rethrow rather than presenting every open PR as vanished.
      if (this.lastGood === null) throw err;
      return { pullRequests: this.lastGood!, closedPullRequests: this.lastGoodClosed!, stale: true };
    }
  }

  /**
   * The four per-PR reads behind {@link CachedPullDetail}, or the last hydration
   * when GitHub's `updated_at` says the pull request has not been touched.
   *
   * The token does **not** cover the world moving underneath — a base branch that
   * advances turns `mergeable_state` `behind` without touching it — so entries
   * also expire after `maxAgeMs`, this PR's [lane](../../world/readPlan.ts).
   */
  private async pullDetail(p: GhPullSummary, viewer: string, maxAgeMs: number): Promise<CachedPullDetail> {
    const { api } = this.opts;
    // No token on the payload means no reuse, ever: "we cannot tell whether it
    // moved" reads as "it did".
    const cached = p.updatedAt === undefined ? undefined : this.detailCache.get(p.number, maxAgeMs);
    if (cached !== undefined && cached.updatedAt === p.updatedAt) return cached;

    const [detail, reviews, comments, threads] = await Promise.all([
      api.getPull(p.number),
      api.listPullReviews(p.number),
      api.listPullReviewComments(p.number),
      this.reviewThreads(p.number),
    ]);
    const fresh: CachedPullDetail = {
      updatedAt: p.updatedAt ?? '',
      approved: computeApproved(reviews),
      viewerApproved: viewerApproved(reviews, viewer),
      reviewThreads: buildReviewThreads(comments, threads ?? [], ourReplyRefs(this.opts.sentReplies, p.number)),
      mergeable: detail.mergeable,
      mergeableState: normalizeMergeState(detail.mergeableState),
      merged: detail.merged,
    };
    // Not cached when the resolution read failed: a degradation must not be served
    // as a hit for as long as the token holds.
    if (p.updatedAt !== undefined && threads !== null) this.detailCache.set(p.number, fresh);
    return fresh;
  }

  /**
   * The two CI reads, or the last hydration when the head SHA has not moved **and**
   * the verdict it produced was terminal. Both conditions: the SHA is what moves on
   * a push, and terminality covers a build that settles with no token moving at all.
   */
  private async pullCi(p: GhPullSummary, maxAgeMs: number): Promise<CachedPullCi> {
    const { api } = this.opts;
    const cached = this.ciCache.get(p.number, maxAgeMs);
    if (cached !== undefined && cached.headSha === p.headSha && ciSettled(cached.ciStatus)) return cached;

    const [status, checks] = await Promise.all([api.getCombinedStatus(p.headSha), api.listCheckRuns(p.headSha)]);
    const fresh: CachedPullCi = {
      headSha: p.headSha,
      ciStatus: aggregateCiStatus(checks, status),
      ciChecks: listCiChecks(checks, status),
    };
    this.ciCache.set(p.number, fresh);
    return fresh;
  }

  /**
   * Review-thread resolution, or null when it cannot be read. The one call in the
   * snapshot allowed to fail on its own: it is the sole GraphQL read here, so it can
   * be unavailable where the REST reads are not, and letting it throw would freeze
   * the whole world over a field that only *refines* a verdict.
   *
   * Absent resolution fails toward a thread staying **open** — an agent dispatched
   * for a resolved comment is visible, a dropped review is not.
   */
  private async reviewThreads(number: number): Promise<GhReviewThread[] | null> {
    try {
      return await this.opts.api.listPullReviewThreads(number);
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} could not read review-thread resolution for PR #${number}: ${(err as Error).message}`,
        detail: 'Falling back to reply-based handling — a resolved thread may still be treated as open.',
      });
      // `null`, not `[]`: stops the hydration cache holding a degraded reading for
      // as long as the token sits still.
      return null;
    }
  }

  /**
   * The PRs that left the open set inside the retention window, in the same domain
   * shape as an open one. No CI/review/comment signal: nothing acts on a dead PR,
   * and the per-PR fetch is the cost this feature must not have.
   */
  private async recentlyClosed(viewer: string): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPulls(since);
    return closed
      .filter((p) => !prAuthor || p.authorLogin === prAuthor)
      .map((p) => {
        const pr = mapClosedPull(p);
        // Answered here too, because the branch reap acts on this list and deleting
        // a colleague's branch is irreversible.
        if (viewer !== '' && p.authorLogin !== '') pr.viewerAuthored = p.authorLogin === viewer;
        return pr;
      });
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    const ref =
      input.commentId !== null
        ? await api.createPullReviewReply(input.prNumber, Number(input.commentId), input.body)
        : await api.createIssueComment(input.prNumber, input.body);
    // Two references: the URL for the audit line, the id for `buildReviewThreads`
    // to recognise on the next read. → `docs/spec/07-pull-requests.md#review-threads`
    return { ok: true, ref: ref.url, commentRef: String(ref.id) };
  }

  /**
   * Mark a review thread resolved. The `commentId` is the thread's root comment —
   * the same id `postPrReply` threads under — so `ok: false` means the pull request
   * carries no such thread.
   */
  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    const resolved = await this.opts.api.resolveReviewThread(input.prNumber, Number(input.commentId));
    return { ok: resolved, ref: resolved ? input.commentId : undefined };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const result = await this.opts.api.mergePull(input.prNumber, input.method);
    return { ok: result.merged, ref: result.sha };
  }

  /**
   * Close a pull request that will not be merged. Always `ok: true`: already-closed
   * is a success, which is what the restart's idempotence rests on; anything else
   * throws.
   */
  async closePr(input: PrCloseInput): Promise<SendResult> {
    await this.opts.api.closePull(input.prNumber);
    return { ok: true, ref: `pr:${input.prNumber}` };
  }

  resolveRefUrl(ref: string): string | null {
    const { owner, repo } = this.opts;
    return owner && repo ? githubRefUrl(owner, repo, ref) : null;
  }

  async setPrLabel(input: PrLabelInput): Promise<SendResult> {
    await this.opts.api.setPullLabel(input.prNumber, input.label, input.present);
    return { ok: true };
  }

  async createPullRequest(input: PrCreateInput): Promise<SendResult> {
    const { number } = await this.opts.api.createPull({
      head: input.branch,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { ok: true, ref: String(number) };
  }

  async setPullTitle(input: PrTitleInput): Promise<SendResult> {
    await this.opts.api.setPullTitle(input.prNumber, input.title);
    return { ok: true };
  }

  async deleteBranch(input: BranchDeleteInput): Promise<SendResult> {
    const deleted = await this.opts.api.deleteBranch(input.branch);
    // Already gone is success; `ref` distinguishes the two for the audit log only.
    return { ok: true, ref: deleted ? input.branch : `${input.branch} (already absent)` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }

  /**
   * Bring a pull request up to date with its base, server-side — nothing is cloned,
   * checked out or pushed here. Always `ok: true`: the endpoint throws rather than
   * declining, and a throw sends the concern back to an agent.
   */
  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    await this.opts.api.updatePullBranch(input.prNumber);
    return { ok: true, ref: input.base };
  }

  /**
   * What the red checks reported, annotations first and the log tail behind them.
   * **Each check is isolated**, so one that 404s costs its own excerpt and not the
   * others'. Nothing is rethrown: this enriches a dispatch going out either way.
   */
  async readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]> {
    const found: CiFailureEvidence[] = [];
    for (const check of checks) {
      const ids = parseEvidenceRef(check.evidenceRef);
      if (!ids) continue;
      try {
        const annotations = await this.opts.api.listCheckRunAnnotations(ids.checkRunId);
        const failures = annotations.filter((a) => a.level === 'failure');
        if (failures.length > 0) {
          found.push({ check: check.name, kind: 'errors', lines: failures.map(annotationLine) });
          continue;
        }
        // No structured error — the common case for a bare test command; fall
        // through to the log, which GitHub only serves whole.
        if (ids.jobId === null) continue;
        const log = await this.opts.api.getJobLog(ids.jobId);
        const all = log.split('\n').filter((l) => l.trim() !== '');
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
          detail: 'The CI-fix agent was dispatched without the failing output; it will reproduce the failure instead.',
        });
      }
    }
    return found;
  }
}

/**
 * The evidence ref for a failing check run: its own id, and the Actions **job** id
 * when one can be recovered from `details_url`. Two ids because annotations are
 * addressed by check run and logs by job; a non-Actions check run yields only the
 * first, which is right — it has annotations and no log.
 */
function checkEvidenceRef(run: GhCheckRun): string | undefined {
  if (run.id === undefined) return undefined;
  const jobId = run.detailsUrl?.match(/\/job\/(\d+)/)?.[1];
  return jobId ? `${run.id}/${jobId}` : String(run.id);
}

/** Read back what {@link checkEvidenceRef} wrote. Anything else yields null and no fetch. */
function parseEvidenceRef(ref: string): { checkRunId: number; jobId: number | null } | null {
  const [check, job] = ref.split('/');
  const checkRunId = Number(check);
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) return null;
  const jobId = job !== undefined && /^\d+$/.test(job) ? Number(job) : null;
  return { checkRunId, jobId };
}

/** One annotation as a line an agent can act on: the place, then what is wrong there. */
function annotationLine(a: GhAnnotation): string {
  const where = a.startLine > 0 ? `${a.path}:${a.startLine}` : a.path;
  const title = a.title && !a.message.startsWith(a.title) ? `${a.title}: ` : '';
  // Flattened so one annotation is one line and the cap's arithmetic stays honest.
  return `${where}: ${title}${a.message.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * Drop the ISO timestamp GitHub prefixes to every log line — 29 characters per
 * line of an excerpt with a character budget, so not cosmetic.
 */
function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

/**
 * A closed GitHub PR as the world models it. `ciStatus`/`unresolvedComments` are
 * blanked rather than fetched: this row exists to be seen, never acted on.
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
    ...(p.mergeCommitSha === null ? {} : { mergeCommitSha: p.mergeCommitSha }),
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
 * The same signals {@link aggregateCiStatus} folds, kept individually so per-check
 * policy can act on *which* check failed. A second pass over the same inputs, so
 * the two agree by construction.
 */
export function listCiChecks(checkRuns: GhCheckRun[], status: GhCombinedStatus): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const run of checkRuns) {
    // Only a failing run gets an evidence ref: a pending one's last output is about
    // an older commit, which is worse than handing an agent nothing.
    const ref =
      run.status === 'completed' && run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion)
        ? checkEvidenceRef(run)
        : undefined;
    const evidence = ref ? { evidenceRef: ref } : {};
    if (run.status !== 'completed') checks.push({ name: run.name, status: 'pending' });
    else if (run.conclusion && FAILING_CONCLUSIONS.has(run.conclusion))
      checks.push({ name: run.name, status: 'failing', ...evidence });
    else checks.push({ name: run.name, status: 'passing' });
  }
  // Commit statuses get no evidence ref, permanently: GitHub has no log API for a
  // third-party status, so there is nothing to fetch.
  for (const s of status.statuses ?? []) {
    if (s.state === 'failure' || s.state === 'error') checks.push({ name: s.context, status: 'failing' });
    else if (s.state === 'pending') checks.push({ name: s.context, status: 'pending' });
    else checks.push({ name: s.context, status: 'passing' });
  }
  return checks;
}

/** Approved iff at least one reviewer's latest review is APPROVED and none is CHANGES_REQUESTED. */
/**
 * Whether **this** operator's own latest review is an approval — never
 * {@link computeApproved}'s fold, which would clear their row on a colleague's
 * answer. Latest-per-reviewer, on the three states that move a stance.
 */
function viewerApproved(reviews: GhReview[], viewer: string): boolean {
  if (viewer === '') return false;
  let latest: GhReview | undefined;
  for (const review of reviews) {
    if (review.reviewerLogin !== viewer) continue;
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') continue;
    if (!latest || (review.submittedAt ?? '') >= (latest.submittedAt ?? '')) latest = review;
  }
  return latest?.state === 'APPROVED';
}

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
 * Group review comments into threads (by `in_reply_to_id`) and say where each one
 * stands. `unresolvedComments` is {@link threadComments} over what this returns,
 * so the rules and the cockpit read the same threads once.
 *
 * Two arms, in order: the reviewer's own **resolution** (a GraphQL read, since
 * REST exposes `isResolved` nowhere — absent means "no verdict", never
 * "unresolved"), then whether **the harness posted the newest reply**, as
 * `ourReplyRefs` records it.
 *
 * **Arm 2 is a record, never the reply's author.** On a single-operator deployment
 * the credential is the operator, so a positional test folds their own follow-up to
 * `PrComment.handled` and silently drops the reviews a human wrote.
 *
 * Both arms fail toward a thread staying **open**: an empty `ourReplyRefs` reads
 * every thread as work, never as handled.
 * → `docs/spec/07-pull-requests.md#attribution-is-a-record-never-an-identity`
 */
export function buildReviewThreads(
  comments: GhReviewComment[],
  threads: GhReviewThread[] = [],
  ourReplies: ReadonlySet<string> = new Set(),
): PrReviewThread[] {
  const resolved = new Set(threads.filter((t) => t.isResolved).map((t) => t.rootCommentId));
  const roots: GhReviewComment[] = [];
  const repliesByRoot = new Map<number, GhReviewComment[]>();
  for (const c of comments) {
    if (c.inReplyToId === null) {
      roots.push(c);
      continue;
    }
    // Comments arrive in creation order, so each root's last entry is its newest reply.
    repliesByRoot.set(c.inReplyToId, [...(repliesByRoot.get(c.inReplyToId) ?? []), c]);
  }
  return roots.map((root) => {
    const replies = repliesByRoot.get(root.id) ?? [];
    const newest = replies[replies.length - 1];
    const thread: PrReviewThread = {
      id: String(root.id),
      author: root.authorLogin,
      body: root.body,
      // Resolution first; failing that, a newest reply the harness has no record of
      // sending leaves the thread unanswered, whoever wrote it.
      state: threadState({
        resolved: resolved.has(root.id),
        answered: newest !== undefined && ourReplies.has(String(newest.id)),
      }),
      replies: replies.map((r) => ({
        id: String(r.id),
        author: r.authorLogin,
        body: r.body,
        // The record, not the author: a reply with no row is not the fleet's.
        ours: ourReplies.has(String(r.id)),
      })),
    };
    // Where the thread hangs, when GitHub reported it — absent rather than guessed.
    if (root.path !== undefined) thread.path = root.path;
    if (root.line !== undefined && root.line !== null) thread.line = root.line;
    return thread;
  });
}
