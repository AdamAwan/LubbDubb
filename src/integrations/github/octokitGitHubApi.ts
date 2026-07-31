import { Octokit } from '@octokit/rest';
import type { MergeMethod } from '../../sink/actionSink.js';
import { withinClosedWindow } from '../closedWindow.js';
import type {
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

  static fromToken(token: string, owner: string, repo: string): OctokitGitHubApi {
    return new OctokitGitHubApi(new Octokit({ auth: token }), owner, repo);
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
    return runs.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion }));
  }

  async listOpenIssues(label?: string): Promise<GhIssue[]> {
    const issues = await this.octokit.paginate(this.octokit.issues.listForRepo, {
      ...this.base,
      state: 'open',
      per_page: 100,
      ...(label ? { labels: label } : {}),
    });
    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body ?? '',
      labels: i.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter((name) => name !== ''),
      state: i.state,
      url: i.html_url,
      isPullRequest: i.pull_request !== undefined,
    }));
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
