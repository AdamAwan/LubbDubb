import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
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
const REVIEW_THREADS_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first: 1) { nodes { databaseId } }
          }
        }
      }
    }
  }
`;

/** Only the fields {@link REVIEW_THREADS_QUERY} selects; everything is nullable per the GraphQL schema. */
interface GqlReviewThreadPage {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        nodes?: Array<{ isResolved?: boolean; comments?: { nodes?: Array<{ databaseId?: number | null }> } } | null>;
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
 * Extra attempts after the first for a request GitHub itself said to retry —
 * a rate limit, a secondary (abuse) limit, a 5xx, a dropped socket.
 *
 * The same budget as Azure's `MAX_RETRIES`, and for the same reason: the snapshot
 * is re-taken every heartbeat anyway, so the retry only has to cover a blip that
 * would otherwise cost a whole cycle's world. Chasing a limit for longer than that
 * spends the pulse waiting instead.
 */
const MAX_RETRIES = 3;

/**
 * Octokit with the two plugins that make a rate limit survivable.
 *
 * Without them a snapshot is one 403 away from failing whole, and the failure is
 * quiet in the way that matters: the integration catches it, records it, and
 * serves `lastGood` — so the dispatcher decides this cycle against a world that
 * may be hours old, and "nothing changed" and "GitHub refused us" look identical
 * from every surface downstream. Azure has retried 429/5xx since it landed; this
 * is the same guarantee on the provider that fans out hardest, since the world
 * read is O(open issues + open PRs) requests per pulse and secondary limits are
 * triggered by exactly that shape of burst.
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
 * Re-poll a PR's detail until GitHub reports a concrete merge state, or the
 * retry budget is spent. GitHub returns `mergeable: null` (state 'unknown') while
 * it (re-)computes lazily — and it re-invalidates every time the base branch
 * moves — so a single read races the background compute and often reads
 * 'unknown', hiding real conflicts (issue #35). Pure over an injected fetch/sleep
 * so it's unit-testable without HTTP. Bounded: on exhaustion it returns the last
 * (still-`null`) detail and the next heartbeat tries again.
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
   * production and silent by default — Azure's arrangement exactly. A limit the
   * retry absorbs still costs the pulse its latency and still says the fleet is
   * reading GitHub too hard, so it is recorded even though nothing failed.
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
          log(
            `GitHub ${options.method} ${options.url}: rate limited, retry ${retryCount + 1}/${MAX_RETRIES} in ${retryAfter}s`,
          );
          return retryCount < MAX_RETRIES;
        },
        // The secondary limit is the one this fleet actually provokes: it is
        // triggered by burst concurrency rather than by an hourly budget, and the
        // snapshot's per-PR and per-issue fan-out is a burst by construction.
        onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
          log(
            `GitHub ${options.method} ${options.url}: secondary rate limit, retry ${retryCount + 1}/${MAX_RETRIES} in ${retryAfter}s`,
          );
          return retryCount < MAX_RETRIES;
        },
      },
    });
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
    }));
  }

  async listRecentlyClosedPulls(since: string): Promise<GhClosedPull[]> {
    // Sorted by `updated`, descending: GitHub cannot filter the list endpoint by
    // close time, but `updated_at >= closed_at` always holds (closing *is* an
    // update), so the first entry whose `updated_at` predates the window proves
    // every later entry is out of it too — and the iterator stops there instead
    // of walking the repo's entire closed-PR history.
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
        });
      }
    }
    return out;
  }

  async getPull(number: number): Promise<GhPullDetail> {
    // GitHub computes `mergeable` lazily: the first read after the value is
    // invalidated returns null/'unknown' and only *triggers* the compute. Re-poll
    // behind this seam so callers get the concrete 'dirty'/'clean'/... instead of
    // a transient 'unknown' (issue #35).
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
    }));
  }

  /**
   * The one GraphQL read in this file, and it is not a preference: thread
   * resolution has no REST representation at all, so `octokit.pulls` cannot
   * answer whether a reviewer marked their comment resolved.
   *
   * Only `isResolved` and the root comment's `databaseId` are selected — the
   * comment bodies keep coming from REST, so this query stays small and a
   * GraphQL outage costs the resolution verdict rather than the comments
   * themselves. Paginated by hand because `octokit.graphql` has no `paginate`.
   */
  async listPullReviewThreads(number: number): Promise<GhReviewThread[]> {
    const threads: GhReviewThread[] = [];
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
        // A thread always has a first comment; a null databaseId would be a
        // thread we cannot join to the REST read, so it is dropped rather than
        // guessed at — it degrades to the reply arm, which is the safe direction.
        const rootCommentId = node.comments?.nodes?.[0]?.databaseId;
        if (typeof rootCommentId !== 'number') continue;
        threads.push({ rootCommentId, isResolved: node.isResolved === true });
      }
      cursor = connection.pageInfo?.hasNextPage ? (connection.pageInfo.endCursor ?? null) : null;
    } while (cursor !== null);
    return threads;
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
    // Octokit follows the 302 to the blob and hands back the body. Typed `unknown`
    // because the generated types call this endpoint's response `never` — it is
    // declared as a redirect rather than as content, so the string it actually
    // resolves to has to be asserted here rather than inferred.
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
   * The same endpoint with `state: 'all'` and a `since` — the one call that can
   * see a closed issue.
   *
   * `sort`/`direction` are pinned to `updated` ascending rather than left to the
   * endpoint's `created` default: the sweep records the newest `changedAt` it saw
   * as its high-water mark, and a page order unrelated to that instant makes a
   * partial read (a rate limit, a dropped connection mid-pagination) leave a mark
   * ahead of items it never fetched. Ascending, the mark only ever moves over
   * ground actually covered.
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
      // A "cross-referenced" event carries a `source.issue`; when that issue is
      // itself a PR (`pull_request` present) its number is the linking PR.
      let sourcePrNumber: number | null = null;
      if (ev.event === 'cross-referenced' && 'source' in ev) {
        const issue = ev.source.issue;
        if (issue && issue.pull_request) sourcePrNumber = issue.number;
      }
      // A `labeled`/`unlabeled` event carries the label and the actor who set it —
      // the "who tagged this" signal. Cast past octokit's broad timeline union.
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

  async setPullLabel(number: number, label: string, present: boolean): Promise<void> {
    await this.setLabel(number, label, present);
  }

  async setIssueLabel(number: number, label: string, present: boolean): Promise<void> {
    await this.setLabel(number, label, present);
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
   * GitHub's own base merge. Answers 202 with a job message rather than a commit —
   * the merge is queued, and the next snapshot is what reports the branch no longer
   * behind, so there is nothing here worth returning. A 422 (the head moved, or the
   * merge is not in fact clean) throws, which is the fallback's signal.
   */
  async updatePullBranch(number: number): Promise<void> {
    await this.octokit.pulls.updateBranch({ ...this.base, pull_number: number });
  }

  /**
   * Delete a branch ref. A 404 (or 422 "Reference does not exist") means the branch
   * is already gone — the common case on a repository with "automatically delete
   * head branches" on, where GitHub removed it at merge time. Reported as `false`
   * rather than thrown: the reap wants "the branch is not there", and both answers
   * satisfy it.
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
    // addLabels is additive and idempotent; removeLabel 404s when the label isn't
    // set, which is a no-op for our purposes.
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
 * One issue row, from either listing. Written once because the two callers must
 * agree field for field: the mirror joins its rows to the world's by number, and a
 * `state` or a label list spelled differently on the two paths would present as a
 * ticket that changes shape depending on which read last touched it.
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
