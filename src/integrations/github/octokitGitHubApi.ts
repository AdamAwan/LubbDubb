import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { EtagCache, installConditionalRequests } from './etagCache.js';
import type { MergeMethod } from '../../sink/actionSink.js';
import { withinClosedWindow } from '../closedWindow.js';
import type {
  GhAnnotation,
  GhCheckRun,
  GhClosedPull,
  GhCombinedStatus,
  GhCommentRef,
  GhIssue,
  GhMergeResult,
  GhPullDetail,
  GhPullSummary,
  GhReview,
  GhReviewComment,
  GhReviewThread,
  GhTimelineEvent,
  GitHubApi,
} from './githubApi.js';

/**
 * Review-thread resolution. GraphQL-only on GitHub — `PullRequestReviewThread`
 * has no REST equivalent — and deliberately narrow: the root comment's
 * `databaseId` to join against the REST comments read, and the reviewer's verdict.
 */
const RESOLVE_THREAD_MUTATION = `
  mutation ($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { isResolved }
    }
  }
`;

const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            comments(first: 1) { nodes { databaseId } }
          }
        }
      }
    }
  }
`;

/** A review thread as {@link REVIEW_THREADS_QUERY} reads it, node id included — this file's shape, not the seam's. */
interface GqlThread {
  nodeId: string;
  rootCommentId: number;
  isResolved: boolean;
}

/** Only the fields {@link REVIEW_THREADS_QUERY} selects; everything is nullable per the GraphQL schema. */
interface GqlReviewThreadPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{
          id?: string | null;
          isResolved?: boolean;
          comments?: { nodes?: Array<{ databaseId?: number | null }> };
        } | null>;
      };
    };
  };
}

/**
 * The real {@link GitHubApi}: one `Octokit` instance, bound to a single
 * `owner`/`repo`, mapping octokit's responses down to the minimal `Gh*` shapes the
 * integrations consume. All GitHub HTTP lives here — nothing else in the repo
 * imports octokit — so the integrations stay network-free and unit-testable.
 */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extra attempts after the first for a request GitHub said to retry. The snapshot is
 * re-taken every heartbeat, so the retry only has to cover a blip; chasing a limit
 * for longer spends the pulse waiting.
 */
const MAX_RETRIES = 3;

/**
 * The longest primary-rate-limit wait worth sitting through, in seconds. A primary
 * limit's `retryAfter` is time-until-the-hour-window-resets, and the snapshot fans
 * out with `Promise.all`, so waiting it out parks every request in flight and holds
 * the pulse — while a failed snapshot already degrades to `lastGood` for free.
 * Anything longer is refused. The **secondary** limit keeps the full budget: it is
 * burst-triggered and backing off is the correct response.
 */
const MAX_PRIMARY_LIMIT_WAIT_S = 60;

/** Whether to sit out a **primary** rate limit. Pure, so the policy above is testable without a clock. */
export function waitOutRateLimit(retryAfterS: number, retryCount: number): boolean {
  if (retryAfterS > MAX_PRIMARY_LIMIT_WAIT_S) return false;
  return retryCount < MAX_RETRIES;
}

/**
 * Octokit with the two plugins that make a rate limit survivable. Without them a
 * snapshot is one 403 from failing whole, and the failure is quiet: the integration
 * serves `lastGood`, so "nothing changed" and "GitHub refused us" look identical
 * downstream. Retrying is the second line — {@link installConditionalRequests} is
 * what keeps the fleet under the budget in the first place.
 */
const ResilientOctokit = Octokit.plugin(retry, throttling);

/** Tuning for {@link resolvePullDetail}: how hard to chase a lazily-computed merge state. */
interface ResolvePullOpts {
  /** Extra reads after the first while GitHub is still computing (`mergeable === null`). */
  retries?: number;
  /** Pause between reads — GitHub's background compute needs a beat to land. */
  delayMs?: number;
  /** Injected for tests so the retry can be driven without real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Re-poll a PR's detail until GitHub reports a concrete merge state, or the budget is
 * spent. GitHub computes `mergeable` lazily and returns null while it does, so a
 * single read often reads 'unknown' and hides a real conflict. Bounded: on
 * exhaustion it returns the still-`null` detail and the next heartbeat tries again.
 */
export async function resolvePullDetail(
  fetchDetail: () => Promise<GhPullDetail>,
  opts: ResolvePullOpts = {},
): Promise<GhPullDetail> {
  const retries = opts.retries ?? 3;
  const delayMs = opts.delayMs ?? 1000;
  const sleep = opts.sleep ?? realSleep;
  let detail = await fetchDetail();
  // A merged PR reports `mergeable: null` too, but there's nothing to compute —
  // stop rather than burn the whole retry budget.
  for (let i = 0; i < retries && detail.mergeable === null && !detail.merged; i++) {
    await sleep(delayMs);
    detail = await fetchDetail();
  }
  return detail;
}

export class OctokitGitHubApi implements GitHubApi {
  private viewer: string | null = null;

  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  /**
   * `log` is the diagnostic sink for retry notices, wired to the error log in
   * production and silent by default. A limit the retry absorbs is still recorded:
   * it says the fleet is reading GitHub too hard.
   */
  static fromToken(
    token: string,
    owner: string,
    repo: string,
    log: (message: string) => void = () => {},
  ): OctokitGitHubApi {
    const octokit = new ResilientOctokit({
      auth: token,
      retry: { retries: MAX_RETRIES },
      throttle: {
        onRateLimit: (retryAfter, options, _octokit, retryCount) => {
          const wait = waitOutRateLimit(retryAfter, retryCount);
          // Recorded either way, and worded by which of the two it is: a window about
          // to turn over, or a read that has outgrown its budget.
          // → {@link MAX_PRIMARY_LIMIT_WAIT_S}
          const where = `GitHub ${options.method} ${options.url}`;
          log(
            wait
              ? `${where}: rate limited, retry ${retryCount + 1}/${MAX_RETRIES} in ${retryAfter}s`
              : `${where}: rate limited for ${retryAfter}s — not waiting; this read serves its last good slice and the next pulse retries`,
          );
          return wait;
        },
        // The secondary limit is the one this fleet provokes: burst concurrency, which
        // the snapshot's per-PR and per-issue fan-out is by construction.
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          log(
            `GitHub ${options.method} ${options.url}: secondary rate limit, retry ${retryCount + 1}/${MAX_RETRIES} in ${retryAfter}s`,
          );
          return retryCount < MAX_RETRIES;
        },
      },
    });
    // Every GET carries the ETag of the reading already held, so an unchanged
    // resource answers 304 and costs no rate-limit budget.
    installConditionalRequests(octokit, new EtagCache());
    return new OctokitGitHubApi(octokit, owner, repo);
  }

  private get base() {
    return { owner: this.owner, repo: this.repo };
  }

  async viewerLogin(): Promise<string> {
    // The login is stable for a token's lifetime, so fetch it once.
    if (this.viewer === null) {
      const { data } = await this.octokit.users.getAuthenticated();
      this.viewer = data.login;
    }
    return this.viewer;
  }

  async listOpenPulls(): Promise<GhPullSummary[]> {
    const pulls = await this.octokit.paginate(this.octokit.pulls.list, { ...this.base, state: 'open', per_page: 100 });
    return pulls.map((p) => ({
      number: p.number,
      title: p.title,
      branch: p.head.ref,
      baseBranch: p.base.ref,
      headSha: p.head.sha,
      authorLogin: p.user?.login ?? '',
      url: p.html_url,
      labels: p.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((name) => name !== ''),
      assigneeLogins: (p.assignees ?? []).map((a) => a.login).filter((login) => login !== ''),
      // The snapshot's change token. Free — it is already on this payload.
      updatedAt: p.updated_at,
    }));
  }

  async listRecentlyClosedPulls(since: string): Promise<GhClosedPull[]> {
    // Sorted by `updated` descending: GitHub cannot filter by close time, but
    // `updated_at >= closed_at` always holds, so the first entry predating the window
    // proves every later one is out of it and the iterator stops there.
    const out: GhClosedPull[] = [];
    const pages = this.octokit.paginate.iterator(this.octokit.pulls.list, {
      ...this.base,
      state: 'closed',
      sort: 'updated',
      direction: 'desc',
      per_page: 100,
    });
    for await (const { data } of pages) {
      for (const p of data) {
        if ((p.updated_at ?? '') < since) return out;
        if (!withinClosedWindow(p.closed_at, since)) continue;
        out.push({
          number: p.number,
          title: p.title,
          branch: p.head.ref,
          baseBranch: p.base.ref,
          authorLogin: p.user?.login ?? '',
          url: p.html_url,
          merged: p.merged_at !== null,
          closedAt: p.closed_at,
          mergeCommitSha: p.merged_at !== null ? (p.merge_commit_sha ?? null) : null,
        });
      }
    }
    return out;
  }

  async getPull(number: number): Promise<GhPullDetail> {
    // Re-poll behind this seam so callers get a concrete state rather than the
    // transient 'unknown' GitHub's lazy compute returns.
    return resolvePullDetail(async () => {
      const { data } = await this.octokit.pulls.get({ ...this.base, pull_number: number });
      return { mergeable: data.mergeable, mergeableState: data.mergeable_state ?? null, merged: data.merged };
    });
  }

  async listPullReviews(number: number): Promise<GhReview[]> {
    const reviews = await this.octokit.paginate(this.octokit.pulls.listReviews, {
      ...this.base,
      pull_number: number,
      per_page: 100,
    });
    return reviews.map((r) => ({
      reviewerLogin: r.user?.login ?? '',
      state: r.state,
      submittedAt: r.submitted_at ?? null,
    }));
  }

  async listPullReviewComments(number: number): Promise<GhReviewComment[]> {
    const comments = await this.octokit.paginate(this.octokit.pulls.listReviewComments, {
      ...this.base,
      pull_number: number,
      per_page: 100,
    });
    return comments.map((c) => ({
      id: c.id,
      authorLogin: c.user?.login ?? '',
      body: c.body,
      inReplyToId: c.in_reply_to_id ?? null,
      path: c.path,
      // `line` is null once the diff moves past a comment; `original_line` is where
      // it was left. An outdated thread genuinely has no current line.
      line: c.line ?? c.original_line ?? null,
    }));
  }

  /**
   * The one GraphQL read in this file, and not a preference: thread resolution has no
   * REST representation. Only the node id, `isResolved` and the root comment's
   * `databaseId` are selected, so a GraphQL outage costs the resolution verdict
   * rather than the comments. Paginated by hand — `octokit.graphql` has no `paginate`.
   */
  private async reviewThreadNodes(number: number): Promise<GqlThread[]> {
    const threads: GqlThread[] = [];
    let cursor: string | null = null;
    do {
      const page: GqlReviewThreadPage = await this.octokit.graphql(REVIEW_THREADS_QUERY, {
        ...this.base,
        number,
        cursor,
      });
      const connection = page.repository?.pullRequest?.reviewThreads;
      if (!connection) break;
      for (const node of connection.nodes ?? []) {
        if (!node) continue;
        // A null databaseId cannot be joined to the REST read, so the thread is
        // dropped rather than guessed at — degrading to the reply arm, the safe way.
        const rootCommentId = node.comments?.nodes?.[0]?.databaseId;
        if (typeof rootCommentId !== 'number' || typeof node.id !== 'string') continue;
        threads.push({ nodeId: node.id, rootCommentId, isResolved: node.isResolved === true });
      }
      cursor = connection.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
    } while (cursor !== null);
    return threads;
  }

  async listPullReviewThreads(number: number): Promise<GhReviewThread[]> {
    const threads = await this.reviewThreadNodes(number);
    // The node id stays in this file: outside it a thread is joined by its root comment.
    return threads.map(({ rootCommentId, isResolved }) => ({ rootCommentId, isResolved }));
  }

  /**
   * The one GraphQL *write*, for the read's reason: no REST equivalent, and it takes
   * the thread's node id. A thread already resolved returns without mutating.
   */
  async resolveReviewThread(number: number, rootCommentId: number): Promise<boolean> {
    const thread = (await this.reviewThreadNodes(number)).find((t) => t.rootCommentId === rootCommentId);
    if (!thread) return false;
    if (thread.isResolved) return true;
    await this.octokit.graphql(RESOLVE_THREAD_MUTATION, { threadId: thread.nodeId });
    return true;
  }

  async getCombinedStatus(sha: string): Promise<GhCombinedStatus> {
    const { data } = await this.octokit.repos.getCombinedStatusForRef({ ...this.base, ref: sha });
    return {
      state: data.state,
      totalCount: data.total_count,
      statuses: data.statuses.map((s) => ({ context: s.context, state: s.state })),
    };
  }

  async listCheckRuns(sha: string): Promise<GhCheckRun[]> {
    const runs = await this.octokit.paginate(this.octokit.checks.listForRef, {
      ...this.base,
      ref: sha,
      per_page: 100,
    });
    return runs.map((run) => ({
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      id: run.id,
      detailsUrl: run.details_url ?? null,
    }));
  }

  async listCheckRunAnnotations(checkRunId: number): Promise<GhAnnotation[]> {
    const annotations = await this.octokit.paginate(this.octokit.checks.listAnnotations, {
      ...this.base,
      check_run_id: checkRunId,
      per_page: 100,
    });
    return annotations.map((a) => ({
      path: a.path,
      startLine: a.start_line,
      level: a.annotation_level ?? '',
      message: a.message ?? '',
      title: a.title ?? '',
    }));
  }

  async getJobLog(jobId: number): Promise<string> {
    // TECHDEBT: Octokit follows the 302 and hands back the body. The generated types call the
    // response `never` (it is declared as a redirect), so the string is asserted here.
    const res = await this.octokit.actions.downloadJobLogsForWorkflowRun({ ...this.base, job_id: jobId });
    return typeof res.data === 'string' ? res.data : String(res.data ?? '');
  }

  async listOpenIssues(label?: string): Promise<GhIssue[]> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      ...this.base,
      state: 'open',
      per_page: 100,
      ...(label ? { labels: label } : {}),
    });
    return issues.map(mapIssue);
  }

  /**
   * The same endpoint with `state: 'all'` and a `since` — the one call that can see a
   * closed issue. `sort`/`direction` are pinned to `updated` **ascending**: the sweep
   * marks the newest `changedAt` it saw, so any other order lets a partial read leave
   * the mark ahead of items it never fetched.
   */
  async listIssuesChangedSince(since: string, label?: string): Promise<GhIssue[]> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      ...this.base,
      state: 'all',
      since,
      sort: 'updated',
      direction: 'asc',
      per_page: 100,
      ...(label ? { labels: label } : {}),
    });
    return issues.map(mapIssue);
  }

  async listIssueTimeline(number: number): Promise<GhTimelineEvent[]> {
    const events = await this.octokit.paginate(this.octokit.issues.listEventsForTimeline, {
      ...this.base,
      issue_number: number,
      per_page: 100,
    });
    return events.map((ev) => {
      // A "cross-referenced" event's `source.issue` is the linking PR when it is one.
      let sourcePrNumber: number | null = null;
      if (ev.event === 'cross-referenced' && 'source' in ev) {
        const issue = ev.source.issue;
        if (issue && issue.pull_request) sourcePrNumber = issue.number;
      }
      // The "who tagged this" signal.
      // TECHDEBT: cast past octokit's broad timeline union.
      let label: string | null = null;
      let actorLogin: string | null = null;
      if (ev.event === 'labeled' || ev.event === 'unlabeled') {
        const le = ev as { label?: { name?: string }; actor?: { login?: string } | null };
        label = le.label?.name ?? null;
        actorLogin = le.actor?.login ?? null;
      }
      return { event: ev.event ?? '', sourcePrNumber, label, actorLogin };
    });
  }

  async createPullReviewReply(number: number, inReplyTo: number, body: string): Promise<GhCommentRef> {
    const { data } = await this.octokit.pulls.createReplyForReviewComment({
      ...this.base,
      pull_number: number,
      comment_id: inReplyTo,
      body,
    });
    return { url: data.html_url, id: data.id };
  }

  async createIssueComment(number: number, body: string): Promise<GhCommentRef> {
    const { data } = await this.octokit.issues.createComment({ ...this.base, issue_number: number, body });
    return { url: data.html_url, id: data.id };
  }

  async updateIssueComment(commentId: number, body: string): Promise<GhCommentRef> {
    const { data } = await this.octokit.issues.updateComment({ ...this.base, comment_id: commentId, body });
    return { url: data.html_url, id: data.id };
  }

  async mergePull(number: number, method: MergeMethod): Promise<GhMergeResult> {
    const { data } = await this.octokit.pulls.merge({ ...this.base, pull_number: number, merge_method: method });
    return { sha: data.sha, merged: data.merged };
  }

  async closePull(number: number): Promise<void> {
    await this.octokit.pulls.update({ ...this.base, pull_number: number, state: 'closed' });
  }

  async setPullLabel(number: number, label: string, present: boolean): Promise<void> {
    await this.setLabel(number, label, present);
  }

  async setIssueLabel(number: number, label: string, present: boolean): Promise<void> {
    await this.setLabel(number, label, present);
  }

  async closeIssue(number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    await this.octokit.issues.update({ ...this.base, issue_number: number, state: 'closed', state_reason: reason });
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels: string[];
    assignee: string | null;
  }): Promise<{ number: number }> {
    const res = await this.octokit.issues.create({
      ...this.base,
      title: input.title,
      body: input.body,
      ...(input.labels.length > 0 ? { labels: input.labels } : {}),
      ...(input.assignee ? { assignees: [input.assignee] } : {}),
    });
    return { number: res.data.number };
  }

  async createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number }> {
    const res = await this.octokit.pulls.create({
      ...this.base,
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { number: res.data.number };
  }

  async setPullTitle(number: number, title: string): Promise<void> {
    await this.octokit.pulls.update({ ...this.base, pull_number: number, title });
  }

  async setPullBase(number: number, base: string): Promise<void> {
    await this.octokit.pulls.update({ ...this.base, pull_number: number, base });
  }

  /**
   * GitHub's own base merge. Answers 202 with a job message rather than a commit, so
   * there is nothing worth returning; a 422 throws, which is the fallback's signal.
   */
  async updatePullBranch(number: number): Promise<void> {
    await this.octokit.pulls.updateBranch({ ...this.base, pull_number: number });
  }

  /**
   * Delete a branch ref. A 404 or 422 means it is already gone, reported as `false`
   * rather than thrown: the reap wants "the branch is not there".
   */
  async deleteBranch(branch: string): Promise<boolean> {
    try {
      await this.octokit.git.deleteRef({ ...this.base, ref: `heads/${branch}` });
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 422) return false;
      throw err;
    }
  }

  /** Shared labels-API write — PRs and issues are the same endpoint on GitHub. */
  private async setLabel(number: number, label: string, present: boolean): Promise<void> {
    // addLabels is additive and idempotent; removeLabel 404s when unset, a no-op here.
    if (present) {
      await this.octokit.issues.addLabels({ ...this.base, issue_number: number, labels: [label] });
    } else {
      try {
        await this.octokit.issues.removeLabel({ ...this.base, issue_number: number, name: label });
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err;
      }
    }
  }
}

/**
 * One issue row, from either listing. Written once because the two callers must agree
 * field for field — the mirror joins its rows to the world's by number.
 */
function mapIssue(i: {
  number: number;
  title: string;
  body?: string | null;
  labels: Array<string | { name?: string }>;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}): GhIssue {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((name) => name !== ''),
    state: i.state,
    url: i.html_url,
    isPullRequest: i.pull_request !== undefined,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
  };
}
