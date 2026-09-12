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
import { ourReplyRefs, threadComments, threadState, type SentPrReplies } from '../../pr/prThreads.js';
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

// → docs/spec/15-integrations.md

interface AzureSourceControlOpts {
  api: AzureDevOpsApi;
  errors?: ErrorRecorder;
  organization?: string;
  project?: string;
  repository?: string;
  prAuthor?: string;
  policyChecks?: PolicyCheckModes;
  closedPrWindowMs?: number;
  now?: () => number;
  sentReplies?: SentPrReplies;
}

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

  private lastGood: PullRequest[] | null = null;
  private lastGoodClosed: PullRequest[] | null = null;
  private mergeCommits = new Map<number, string>();
  private readonly policyReadings = new HydrationCache<{ token: string; evals: AzPolicyEvaluation[] }>();

  constructor(private readonly opts: AzureSourceControlOpts) {}

  resolveRefUrl(ref: string): string | null {
    const { organization, project, repository } = this.opts;
    return organization && project && repository ? azureRefUrl(organization, project, repository, ref) : null;
  }

  async snapshot(plan?: ReadPlan): Promise<WorldSlice> {
    try {
      const { api, prAuthor } = this.opts;
      const viewer = await api.viewerUniqueName();
      let pulls = await api.listActivePullRequests();
      if (prAuthor) {
        pulls = pulls.filter(
          (p) => sameIdentity(p.authorUniqueName, prAuthor) || viewerAssignment(p.reviewers, prAuthor) !== undefined,
        );
      }
      const closedPullRequests = await this.recentlyClosed(viewer);

      const pullRequests = await Promise.all(
        pulls.map(async (p): Promise<PullRequest> => {
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
            ...(p.lastMergeSourceCommit ? { headSha: p.lastMergeSourceCommit } : {}),
            ciStatus: aggregatePolicyCiStatus(policyEvals),
            ciChecks: listPolicyCiChecks(policyEvals, this.opts.policyChecks),
            ciChecksWithheld: policyCiDetailWithheld(policyEvals, this.opts.policyChecks),
            unresolvedComments: threadComments(reviewThreads),
            reviewThreads,
            approved: computeApproved(p.reviewers.map((r) => r.vote)),
            mergeableState: normalizeMergeState(p.mergeStatus, p.isDraft),
            merged: false,
            state: 'open',
            labels,
            url: p.url,
          };
          const author = p.authorDisplayName || p.authorUniqueName;
          if (author !== '') pr.author = author;
          if (viewer !== '' && p.authorUniqueName !== '') pr.viewerAuthored = sameIdentity(p.authorUniqueName, viewer);
          const assignment = viewerAssignment(p.reviewers, viewer);
          if (assignment !== undefined) pr.viewerAssignment = assignment;
          if (viewerApproved(p.reviewers, viewer)) pr.viewerApproved = true;
          const mergeable = mergeableFromStatus(p.mergeStatus);
          if (mergeable !== undefined) pr.mergeable = mergeable;
          return pr;
        }),
      );

      this.policyReadings.retain(pulls.map((p) => p.pullRequestId));
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

  private async policyEvaluations(p: AzPull, threads: AzThread[], maxAgeMs: number): Promise<AzPolicyEvaluation[]> {
    const token = policyReuseToken(p, threads);
    const hit = this.policyReadings.get(p.pullRequestId, maxAgeMs);
    if (hit !== undefined && hit.token === token && policyEvalsSettled(hit.evals)) return hit.evals;
    const evals = await this.opts.api.listPolicyEvaluations(p.pullRequestId);
    this.policyReadings.set(p.pullRequestId, { token, evals });
    return evals;
  }

  private async recentlyClosed(viewer: string): Promise<PullRequest[]> {
    const { api, prAuthor, closedPrWindowMs } = this.opts;
    if (!closedPrWindowMs || closedPrWindowMs <= 0) return [];
    const since = closedWindowStart((this.opts.now ?? Date.now)(), closedPrWindowMs);
    const closed = await api.listRecentlyClosedPullRequests(since);
    return closed
      .filter((p) => !prAuthor || p.authorUniqueName === prAuthor)
      .map((p) => {
        const pr = mapClosedPull(p);
        if (viewer !== '' && p.authorUniqueName !== '') pr.viewerAuthored = sameIdentity(p.authorUniqueName, viewer);
        return pr;
      });
  }

  async postPrReply(input: PrReplyInput): Promise<SendResult> {
    const { api } = this.opts;
    const ref =
      input.commentId !== null
        ? await api.createThreadReply(input.prNumber, Number(input.commentId), 1, input.body)
        : await api.createThread(input.prNumber, input.body);
    const threadRef =
      input.commentId !== null ? input.commentId : ref.threadId === undefined ? undefined : String(ref.threadId);
    return {
      ok: true,
      ref: ref.url,
      ...(ref.id === undefined ? {} : { commentRef: String(ref.id) }),
      ...(threadRef === undefined ? {} : { threadRef }),
    };
  }

  async resolvePrThread(input: PrThreadResolveInput): Promise<SendResult> {
    await this.opts.api.setThreadStatus(input.prNumber, Number(input.commentId), 'fixed');
    return { ok: true, ref: input.commentId };
  }

  async mergePr(input: PrMergeInput): Promise<SendResult> {
    const commit = this.mergeCommits.get(input.prNumber);
    if (!commit) {
      throw new Error(`no known merge commit for PR ${input.prNumber}; snapshot it before merging`);
    }
    const result = await this.opts.api.completePullRequest(input.prNumber, commit, input.method);
    const ok = result.status === 'completed' || result.status === 'queued';
    return { ok, ref: result.status };
  }

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
    return { ok: true, ref: deleted ? input.branch : `${input.branch} (already absent)` };
  }

  async setPullBase(input: PrBaseInput): Promise<SendResult> {
    await this.opts.api.setPullBase(input.prNumber, input.base);
    return { ok: true };
  }

  async requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult> {
    const res = await this.opts.api.requeuePolicyEvaluation(input.requeueRef);
    if (res.isExpired === true) return { ok: false };
    return { ok: true, ref: `${input.check} (${res.status ?? 'queued'})` };
  }

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

function taskIssueLine(record: AzTimelineRecord, message: string): string {
  return `${record.name}: ${message.replace(/\s*\n\s*/g, ' ').trim()}`;
}

function stripLogTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

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

export function stripRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

export function normalizeMergeState(mergeStatus: string, isDraft: boolean): MergeableState {
  if (isDraft) return 'blocked';
  switch (mergeStatus) {
    case 'conflicts':
      return 'dirty';
    case 'succeeded':
      return 'clean';
    case 'rejectedByPolicy':
      return 'blocked';
    default:
      return 'unknown';
  }
}

export function mergeableFromStatus(mergeStatus: string): boolean | undefined {
  if (mergeStatus === 'succeeded') return true;
  if (mergeStatus === 'conflicts') return false;
  return undefined;
}

function policyReuseToken(p: AzPull, threads: AzThread[]): string {
  const reviewers = p.reviewers.map((r) => `${r.uniqueName}:${r.vote}:${r.isRequired}`).sort();
  const threadFingerprint = threads.map((t) => `${t.id}:${t.status ?? ''}:${t.comments.length}`).sort();
  return JSON.stringify([p.lastMergeSourceCommit, p.mergeStatus, p.isDraft, reviewers, threadFingerprint]);
}

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

export function aggregatePolicyCiStatus(evals: AzPolicyEvaluation[]): CiStatus {
  let failing = false;
  let pending = false;
  let passing = false;

  for (const e of evals) {
    const kind = policyKindOf(e.typeId);
    if (!e.isEnabled || !e.isBlocking || (kind !== 'build' && kind !== 'status')) continue;
    switch (e.status) {
      case 'rejected':
      case 'broken':
        failing = true;
        break;
      case 'queued':
      case 'running':
        pending = true;
        break;
      case 'approved':
        passing = true;
        break;
    }
  }

  if (failing) return 'failing';
  if (pending) return 'pending';
  if (passing) return 'passing';
  return 'unknown';
}

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
    if (status === 'failing' && e.buildId !== undefined) check.evidenceRef = String(e.buildId);
    if (e.displayAliases && e.displayAliases.length > 0) check.aliases = [...e.displayAliases];
    if (mode === 'advisory') check.advisory = true;
    if (status === 'pending' && e.isExpired) {
      check.expired = true;
      if (e.evaluationId) check.requeueRef = e.evaluationId;
    }
    checks.push(check);
  }
  return checks;
}

function checkStatusOf(status: string | null): CiCheck['status'] | null {
  if (status === 'rejected' || status === 'broken') return 'failing';
  if (status === 'queued' || status === 'running') return 'pending';
  if (status === 'approved') return 'passing';
  return null;
}

function viewerAssignment(reviewers: readonly AzReviewer[], viewer: string): ViewerAssignment | undefined {
  if (viewer === '') return undefined;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  if (mine === undefined) return undefined;
  return mine.isRequired ? 'reviewer-required' : 'reviewer-optional';
}

function viewerApproved(reviewers: readonly AzReviewer[], viewer: string): boolean {
  if (viewer === '') return false;
  const mine = reviewers.find((r) => !r.isContainer && sameIdentity(r.uniqueName, viewer));
  return mine !== undefined && mine.vote >= 5;
}

function sameIdentity(a: string, b: string): boolean {
  return a !== '' && a.toLowerCase() === b.toLowerCase();
}

export function computeApproved(votes: number[]): boolean {
  if (votes.some((v) => v < 0)) return false;
  return votes.some((v) => v >= 5);
}

export function buildReviewThreads(threads: AzThread[], ourReplies: ReadonlySet<string> = new Set()): PrReviewThread[] {
  const RESOLVED: ReadonlySet<string> = new Set(['fixed', 'closed', 'wontFix', 'byDesign']);
  const out: PrReviewThread[] = [];
  for (const thread of threads) {
    const comments = thread.comments.filter((c) => c.commentType !== 'system');
    const root = comments[0];
    if (!root) continue;
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
        ours: ourReplies.has(String(c.id)),
      })),
    };
    if (thread.filePath !== undefined && thread.filePath !== null) built.path = thread.filePath.replace(/^\//, '');
    if (thread.line !== undefined && thread.line !== null) built.line = thread.line;
    if (thread.properties !== undefined && thread.properties !== null && Object.keys(thread.properties).length > 0) {
      built.properties = thread.properties;
    }
    out.push(built);
  }
  return out;
}

export function mergeStrategyFor(method: MergeMethod): string {
  switch (method) {
    case 'squash':
      return 'squash';
    case 'rebase':
      return 'rebase';
    default:
      return 'noFastForward';
  }
}
