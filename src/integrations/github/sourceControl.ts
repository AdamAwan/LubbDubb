import type { ErrorRecorder } from '../../errorLog.js';
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
import type { CiCheck, CiStatus, MergeableState, PrComment, PullRequest } from '../../types.js';
import { EVIDENCE_LOG_TAIL_LINES, type CiEvidenceTarget, type CiFailureEvidence } from '../../ci/ciEvidence.js';
import type {
  BranchDeleteCapable,
  WorldCapability,
  CiEvidenceCapable,
  Integration,
  PrBaseCapable,
  PrBaseUpdateCapable,
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
import { githubRefUrl } from './refUrl.js';

/**
 * The half of a hydrated pull request that costs the four per-PR reads —
 * `getPull`, `listPullReviews`, `listPullReviewComments` and the review-thread
 * GraphQL query — held against the `updated_at` the list payload reported when
 * it was read. Everything else on a {@link PullRequest} comes off the list
 * payload, which is fetched every pulse and so is never cached.
 */
interface CachedPullDetail {
  /** The token this hydration is valid for. */
  updatedAt: string;
  approved: boolean;
  viewerApproved: boolean;
  unresolvedComments: PrComment[];
  mergeable: boolean | null;
  mergeableState: MergeableState;
  merged: boolean;
}

/**
 * The CI half, held against the head SHA rather than `updated_at` — a check run
 * completing does not touch a pull request's `updated_at`, so gating these on it
 * would freeze a red build as green (or a green one as pending) for as long as
 * nobody commented.
 */
interface CachedPullCi {
  headSha: string;
  ciStatus: CiStatus;
  ciChecks: CiCheck[];
}

/**
 * Whether a CI reading is finished with, i.e. safe to reuse while the head SHA
 * holds. `pending` is a build still running and `unknown` is one nothing has
 * reported yet — both are readings that will change without any token moving, so
 * both are refetched every pulse.
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
   * is a *current* reading GitHub's own list payload says has not moved, so it
   * never sets `stale`, which means the read failed. → {@link HydrationCache}
   */
  private readonly detailCache: HydrationCache<CachedPullDetail>;
  private readonly ciCache: HydrationCache<CachedPullCi>;

  constructor(private readonly opts: GitHubSourceControlOpts) {
    this.detailCache = new HydrationCache(opts.now);
    this.ciCache = new HydrationCache(opts.now);
  }

  async snapshot(): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerLogin();
      let pulls = await api.listOpenPulls();
      // "Your work" is what you opened **or what somebody handed you**. Narrowed to
      // authorship alone, a pull request assigned to the operator never entered the
      // world at all, so the assignment could not be reported and the queue could
      // not raise it — on the default `ownWorkOnly`, which is every real
      // deployment. Widening costs no request: `assigneeLogins` rides on the list
      // payload the filter already reads.
      if (prAuthor) pulls = pulls.filter((p) => p.authorLogin === prAuthor || p.assigneeLogins.includes(prAuthor));
      const closedPullRequests = await this.recentlyClosed();

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          const [detail, ci] = await Promise.all([this.pullDetail(p, viewer), this.pullCi(p)]);
          const pr: PullRequest = {
            id: `pr_${p.number}`,
            number: p.number,
            title: p.title,
            branch: p.branch,
            baseBranch: p.baseBranch,
            // The commit the checks above ran against — what tells a check that was
            // fixed from one that flaked (`src/knowledge/noticeDesk.ts`).
            headSha: p.headSha,
            ciStatus: ci.ciStatus,
            ciChecks: ci.ciChecks,
            unresolvedComments: detail.unresolvedComments,
            approved: detail.approved,
            mergeableState: detail.mergeableState,
            merged: detail.merged,
            // Listed as open, so 'open' unless the detail read caught it mid-merge.
            state: detail.merged ? 'merged' : 'open',
            labels: p.labels,
            url: p.url,
          };
          // The login is the only name GitHub puts on the list payload, and it is
          // the name a reviewer is asked by — enough for a row to say who asked.
          if (p.authorLogin !== '') pr.author = p.authorLogin;
          // Only ever `true`: a reviewer who has not answered and one GitHub
          // reports no review from are the same silence, and `false` would assert
          // a verdict nobody gave.
          if (detail.viewerApproved) pr.viewerApproved = true;
          // Resolved against `viewer` — the identity the token actually is — and
          // never against `prAuthor`, which is a *filter* and is unset the moment a
          // project turns `ownWorkOnly` off. Read the other way round, turning the
          // filter off would take the assignment with it.
          if (viewer !== '' && p.assigneeLogins.includes(viewer)) pr.viewerAssignment = 'assignee';
          // GitHub's tri-state `mergeable`: true/false is a real signal, null means
          // "still computing" — leave it unknown rather than asserting not-mergeable.
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
      // "Last good" means a read that succeeded. With none yet, an empty slice is a
      // fabricated world, not a stale one — rethrow so the pulse fails rather than
      // presenting every open PR as vanished.
      if (this.lastGood === null) throw err;
      return { pullRequests: this.lastGood!, closedPullRequests: this.lastGoodClosed!, stale: true };
    }
  }

  /**
   * The four per-PR reads behind {@link CachedPullDetail}, or the last hydration
   * when GitHub's `updated_at` says the pull request has not been touched since.
   *
   * Everything gated here changes only through something done *to* the pull
   * request — a review, a comment, a resolution, a push, a retarget — and every
   * one of those bumps `updated_at`. What it does **not** cover is the world
   * moving underneath: a base branch that advances turns `mergeable_state`
   * `behind` or `dirty` without touching this token, which is why the cache
   * expires entries rather than trusting one forever
   * (`MAX_REUSE_MS` in {@link HydrationCache}).
   */
  private async pullDetail(p: GhPullSummary, viewer: string): Promise<CachedPullDetail> {
    const { api } = this.opts;
    // No token on the payload (an old fixture) means no reuse, ever — the cache
    // must not invent a token, since the only safe reading of "we cannot tell
    // whether it moved" is that it did.
    const cached = p.updatedAt === undefined ? undefined : this.detailCache.get(p.number);
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
      unresolvedComments: buildUnresolvedComments(comments, viewer, threads ?? []),
      mergeable: detail.mergeable,
      mergeableState: normalizeMergeState(detail.mergeableState),
      merged: detail.merged,
    };
    // Not cached when the resolution read failed — `fresh` is then a degradation,
    // and a degradation must not be served as a hit for as long as the token holds.
    if (p.updatedAt !== undefined && threads !== null) this.detailCache.set(p.number, fresh);
    return fresh;
  }

  /**
   * The two CI reads, or the last hydration when the head SHA has not moved
   * **and** the verdict it produced was terminal.
   *
   * Both conditions, because each covers what the other cannot. The SHA is the
   * only token that moves when a push invalidates a build — `updated_at` does
   * move on a push too, but the reverse does not hold, and a comment must not buy
   * a CI refetch it changes nothing about. Terminality covers the rest: a build
   * that is queued, running or has not reported settles with no token moving at
   * all, so anything short of `passing`/`failing` is re-read every pulse. A
   * settled verdict on an unmoved commit is the one reading that cannot change.
   */
  private async pullCi(p: GhPullSummary): Promise<CachedPullCi> {
    const { api } = this.opts;
    const cached = this.ciCache.get(p.number);
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
   * Review-thread resolution, or an empty list when it cannot be read.
   *
   * The one call in the snapshot allowed to fail on its own. It is the sole
   * GraphQL read here (resolution has no REST form), so it can be unavailable for
   * reasons the REST reads are not — a token without GraphQL access, an Enterprise
   * Server that answers the schema differently, a proxy that passes `/repos` and
   * not `/graphql`. Letting that throw would take the whole snapshot down to
   * `lastGood` and freeze the world over a field that only *refines* a verdict.
   *
   * Absent resolution degrades to the reply arm of `buildUnresolvedComments` —
   * i.e. exactly the behaviour before this existed — which fails toward a thread
   * staying *open*, the safe direction: an operator sees an agent dispatched for a
   * comment they had resolved, rather than their review being silently dropped.
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
      // `null`, not `[]`: the difference is what stops the hydration cache from
      // holding a degraded reading for as long as the token sits still. A
      // GraphQL outage is retried on the next pulse, exactly as before the cache.
      return null;
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

  /**
   * Mark a review thread resolved. The `commentId` is the thread's root comment —
   * the same id `postPrReply` threads under and the same id
   * {@link buildUnresolvedComments} keys a `PrComment` on — so the caller needs no
   * second identifier, and `ok: false` means the pull request carries no such
   * thread.
   */
  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    const resolved = await this.opts.api.resolveReviewThread(input.prNumber, Number(input.commentId));
    return { ok: resolved, ref: resolved ? input.commentId : undefined };
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
    // Already gone is success. `ref` distinguishes the two for the audit log without
    // making the caller care, because nothing downstream should.
    return { ok: true, ref: deleted ? input.branch : `${input.branch} (already absent)` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }

  /**
   * Bring a pull request up to date with its base, server-side (issue #332).
   * Nothing is cloned, checked out or pushed from here — GitHub merges the base in
   * on its own machines, which is the whole saving over the code agent this
   * replaces. Always `ok: true`: the endpoint throws rather than declining, and a
   * throw is what sends the concern back to an agent.
   */
  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    await this.opts.api.updatePullBranch(input.prNumber);
    return { ok: true, ref: input.base };
  }

  /**
   * What the red checks reported, annotations first and the log tail behind them.
   *
   * Per check rather than in one batch because the two reads are per check at the
   * API, and **each check is isolated**: one that 404s (a log aged out of
   * retention, a token without `actions:read`) costs its own excerpt and not the
   * others'. Everything is recorded and nothing is rethrown — this enriches a
   * dispatch that is going out either way, so a failure here must leave the
   * prompt as it was rather than take the dispatch down with it.
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
        // No structured error — the common case for a bare test command. Fall
        // through to the log, which for GitHub means downloading it whole.
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
 * The evidence ref for a failing check run: its own id, and the Actions **job**
 * id when one can be recovered from `details_url`.
 *
 * Two ids because the two reads take different ones — annotations are addressed
 * by check run, logs by job — and the job id exists nowhere in the check-run
 * payload but that URL. A check run from a non-Actions app yields the first and
 * not the second, which is exactly right: it has annotations and no log.
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
  // Annotations wrap their own message across lines; flattened so one annotation
  // is one line and the cap's line arithmetic stays honest.
  return `${where}: ${title}${a.message.replace(/\s*\n\s*/g, ' ').trim()}`;
}

/**
 * Drop the ISO timestamp GitHub prefixes to every log line.
 *
 * Not cosmetic: it is 29 characters on every line of an excerpt with a character
 * budget, so keeping it would spend something like a fifth of the evidence on
 * telling an agent what time the build ran.
 */
function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
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
    // Only a failing run gets an evidence ref. A passing one has no failure to
    // fetch, and a pending one's last output is about an older commit — handing
    // that to an agent would point it at code the branch has moved past, which is
    // worse than handing it nothing.
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
  // Commit statuses get no evidence ref, permanently. A status names a
  // third-party system by `target_url` and GitHub has no log API for it — there
  // is nothing to fetch, as opposed to something not yet wired up.
  for (const s of status.statuses ?? []) {
    if (s.state === 'failure' || s.state === 'error') checks.push({ name: s.context, status: 'failing' });
    else if (s.state === 'pending') checks.push({ name: s.context, status: 'pending' });
    else checks.push({ name: s.context, status: 'passing' });
  }
  return checks;
}

/** Approved iff at least one reviewer's latest review is APPROVED and none is CHANGES_REQUESTED. */
/**
 * Whether **this** operator's own latest review is an approval.
 *
 * Their review, never {@link computeApproved}'s fold: a pull request somebody
 * else approved is still waiting on the review this operator was asked for, and
 * reading the aggregate here would clear their row on a colleague's answer.
 *
 * Latest-per-reviewer, on the same three states that move a stance — a later
 * `CHANGES_REQUESTED` or `DISMISSED` takes an earlier approval back, and a
 * `COMMENTED` leaves it standing.
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
 * Group review comments into threads (by `in_reply_to_id`) and surface one
 * {@link PrComment} per thread, keyed on the thread root.
 *
 * Two arms, in this order — the same shape as the Azure provider's, which is the
 * point: both trackers have a real resolution verdict, so both read it.
 *
 * 1. **The reviewer resolved the thread.** Their own answer to "has this been
 *    dealt with", and the only authoritative one. It costs a GraphQL read
 *    (`listPullReviewThreads`) because GitHub exposes `isResolved` nowhere in
 *    REST — which is the entire reason this function ever had to infer anything.
 *    `threads` is empty when that read failed or when a caller does not supply
 *    one, and absence means "no verdict", never "unresolved".
 * 2. **The harness posted the newest reply.** The fallback for a thread nobody
 *    resolved, and the network-native analogue of the fake's `markCommentHandled`,
 *    so the deterministic loop settles one poll after a reply goes out.
 *
 * **Arm 2 is positional rather than an identity test, and has to be.**
 * `viewerLogin` is whoever holds `GITHUB_TOKEN`, which on a single-operator
 * deployment is the operator themselves. Comparing the *root's* author against it
 * marked every review comment the operator left as already handled the instant
 * they wrote it, and rule `pr-review-comment` never saw it: the harness silently ignored exactly
 * the reviews a human took the time to write, which is the one signal it must
 * never drop. No author comparison fixes that — the two identities are the same
 * string. The position test needs none: the harness only ever posts *replies*
 * under a root (`createPullReviewReply`; a `commentId: null` reply is an issue
 * comment, which this list never contains), so "the newest reply is ours" holds
 * whether the token belongs to a dedicated bot account or to the operator.
 *
 * Both arms fail toward a thread staying **open**, which is the safe direction: an
 * agent dispatched for a comment already dealt with is visible and cheap, where a
 * dropped review is neither.
 */
export function buildUnresolvedComments(
  comments: GhReviewComment[],
  viewerLogin: string,
  threads: GhReviewThread[] = [],
): PrComment[] {
  const resolved = new Set(threads.filter((t) => t.isResolved).map((t) => t.rootCommentId));
  const roots: GhReviewComment[] = [];
  const latestReplyByRoot = new Map<number, GhReviewComment>();
  for (const c of comments) {
    if (c.inReplyToId === null) {
      roots.push(c);
      continue;
    }
    // Comments arrive in creation order, so the last write per root is the latest.
    latestReplyByRoot.set(c.inReplyToId, c);
  }
  return roots.map((root) => ({
    id: String(root.id),
    author: root.authorLogin,
    body: root.body,
    // Resolution first; failing that, a thread with no reply of ours is
    // unanswered, whoever wrote it.
    handled: resolved.has(root.id) || latestReplyByRoot.get(root.id)?.authorLogin === viewerLogin,
  }));
}
