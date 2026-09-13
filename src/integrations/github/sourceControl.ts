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
import { ourReplyRefs, threadComments, threadState, type SentPrReplies } from '../../pr/prThreads.js';
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

// → docs/spec/15-integrations.md

interface CachedPullDetail {
  updatedAt: string;
  approved: boolean;
  viewerApproved: boolean;
  reviewThreads: PrReviewThread[];
  mergeable: boolean | null;
  mergeableState: MergeableState;
  merged: boolean;
  changedFiles: number | null;
}

interface CachedPullCi {
  headSha: string;
  ciStatus: CiStatus;
  ciChecks: CiCheck[];
}

function ciSettled(status: CiStatus): boolean {
  return status === 'passing' || status === 'failing';
}

interface GitHubSourceControlOpts {
  api: GitHubApi;
  errors?: ErrorRecorder;
  prAuthor?: string;
  owner?: string;
  repo?: string;
  closedPrWindowMs?: number;
  now?: () => number;
  sentReplies?: SentPrReplies;
}

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

  private lastGood: PullRequest[] | null = null;
  private lastGoodClosed: PullRequest[] | null = null;

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
      if (prAuthor) pulls = pulls.filter((p) => p.authorLogin === prAuthor || p.assigneeLogins.includes(prAuthor));
      const closedPullRequests = await this.recentlyClosed(viewer);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
          const maxAgeMs = hydrationMaxAgeMs(plan, prReadRef(p.number));
          const [detail, ci] = await Promise.all([this.pullDetail(p, viewer, maxAgeMs), this.pullCi(p, maxAgeMs)]);
          const pr: PullRequest = {
            id: `pr_${p.number}`,
            number: p.number,
            title: p.title,
            branch: p.branch,
            baseBranch: p.baseBranch,
            headSha: p.headSha,
            ciStatus: ci.ciStatus,
            ciChecks: ci.ciChecks,
            unresolvedComments: threadComments(detail.reviewThreads),
            reviewThreads: detail.reviewThreads,
            approved: detail.approved,
            mergeableState: detail.mergeableState,
            merged: detail.merged,
            state: detail.merged ? 'merged' : 'open',
            labels: p.labels,
            url: p.url,
          };
          if (p.authorLogin !== '') pr.author = p.authorLogin;
          if (viewer !== '' && p.authorLogin !== '') pr.viewerAuthored = p.authorLogin === viewer;
          if (detail.viewerApproved) pr.viewerApproved = true;
          if (viewer !== '' && p.assigneeLogins.includes(viewer)) pr.viewerAssignment = 'assignee';
          if (detail.mergeable !== null) pr.mergeable = detail.mergeable;
          if (detail.changedFiles !== null) pr.changedFiles = detail.changedFiles;
          return pr;
        }),
      );

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
      if (this.lastGood === null) throw err;
      return { pullRequests: this.lastGood!, closedPullRequests: this.lastGoodClosed!, stale: true };
    }
  }

  private async pullDetail(p: GhPullSummary, viewer: string, maxAgeMs: number): Promise<CachedPullDetail> {
    const { api } = this.opts;
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
      changedFiles: detail.changedFiles ?? null,
    };
    if (p.updatedAt !== undefined && threads !== null) this.detailCache.set(p.number, fresh);
    return fresh;
  }

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

  private async reviewThreads(number: number): Promise<GhReviewThread[] | null> {
    try {
      return await this.opts.api.listPullReviewThreads(number);
    } catch (err) {
      this.opts.errors?.record({
        source: 'provider',
        message: `${this.id} could not read review-thread resolution for PR #${number}: ${(err as Error).message}`,
        detail: 'Falling back to reply-based handling — a resolved thread may still be treated as open.',
      });
      return null;
    }
  }

  private async recentlyClosed(viewer: string): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPulls(since);
    return closed
      .filter((p) => !prAuthor || p.authorLogin === prAuthor)
      .map((p) => {
        const pr = mapClosedPull(p);
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
    return { ok: true, ref: ref.url, commentRef: String(ref.id) };
  }

  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    const resolved = await this.opts.api.resolveReviewThread(input.prNumber, Number(input.commentId));
    return { ok: resolved, ref: resolved ? input.commentId : undefined };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const result = await this.opts.api.mergePull(input.prNumber, input.method);
    return { ok: result.merged, ref: result.sha };
  }

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
    return { ok: true, ref: deleted ? input.branch : `${input.branch} (already absent)` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }

  async updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult> {
    await this.opts.api.updatePullBranch(input.prNumber);
    return { ok: true, ref: input.base };
  }

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

function checkEvidenceRef(run: GhCheckRun): string | undefined {
  if (run.id === undefined) return undefined;
  const jobId = run.detailsUrl?.match(/\/job\/(\d+)/)?.[1];
  return jobId ? `${run.id}/${jobId}` : String(run.id);
}

function parseEvidenceRef(ref: string): { checkRunId: number; jobId: number | null } | null {
  const [check, job] = ref.split('/');
  const checkRunId = Number(check);
  if (!Number.isInteger(checkRunId) || checkRunId <= 0) return null;
  const jobId = job !== undefined && /^\d+$/.test(job) ? Number(job) : null;
  return { checkRunId, jobId };
}

function annotationLine(a: GhAnnotation): string {
  const where = a.startLine > 0 ? `${a.path}:${a.startLine}` : a.path;
  const title = a.title && !a.message.startsWith(a.title) ? `${a.title}: ` : '';
  return `${where}: ${title}${a.message.replace(/\s*\n\s*/g, ' ').trim()}`;
}

function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

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

function normalizeMergeState(state: string | null): MergeableState {
  switch (state) {
    case 'dirty':
    case 'behind':
    case 'blocked':
    case 'clean':
      return state;
    default:
      return 'unknown';
  }
}

const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'cancelled', 'timed_out', 'action_required']);

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
      success = true;
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

export function listCiChecks(checkRuns: GhCheckRun[], status: GhCombinedStatus): CiCheck[] {
  const checks: CiCheck[] = [];
  for (const run of checkRuns) {
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
  for (const s of status.statuses ?? []) {
    if (s.state === 'failure' || s.state === 'error') checks.push({ name: s.context, status: 'failing' });
    else if (s.state === 'pending') checks.push({ name: s.context, status: 'pending' });
    else checks.push({ name: s.context, status: 'passing' });
  }
  return checks;
}

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
    if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED' && review.state !== 'DISMISSED') continue;
    const prev = latest.get(review.reviewerLogin);
    if (!prev || (review.submittedAt ?? '') >= (prev.submittedAt ?? '')) latest.set(review.reviewerLogin, review);
  }
  const states = [...latest.values()].map((r) => r.state);
  if (states.includes('CHANGES_REQUESTED')) return false;
  return states.includes('APPROVED');
}

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
    repliesByRoot.set(c.inReplyToId, [...(repliesByRoot.get(c.inReplyToId) ?? []), c]);
  }
  return roots.map((root) => {
    const replies = repliesByRoot.get(root.id) ?? [];
    const newest = replies[replies.length - 1];
    const thread: PrReviewThread = {
      id: String(root.id),
      author: root.authorLogin,
      body: root.body,
      state: threadState({
        resolved: resolved.has(root.id),
        answered: newest !== undefined && ourReplies.has(String(newest.id)),
      }),
      replies: replies.map((r) => ({
        id: String(r.id),
        author: r.authorLogin,
        body: r.body,
        ours: ourReplies.has(String(r.id)),
      })),
    };
    if (root.path !== undefined) thread.path = root.path;
    if (root.line !== undefined && root.line !== null) thread.line = root.line;
    return thread;
  });
}
