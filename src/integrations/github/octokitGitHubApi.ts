import { Octokit } from '@octokit/rest';
import type { MergeMethod } from '../../sink/actionSink.js';
import type {
  GhCheckRun,
  GhCombinedStatus,
  GhCommentRef,
  GhIssue,
  GhMergeResult,
  GhPullDetail,
  GhPullSummary,
  GhReview,
  GhReviewComment,
  GhTimelineEvent,
  GitHubApi,
} from './githubApi.js';

/**
 * The real {@link GitHubApi}: one `Octokit` instance, bound to a single
 * `owner`/`repo`, mapping octokit's responses down to the minimal `Gh*` shapes the
 * integrations consume. All GitHub HTTP lives here — nothing else in the repo
 * imports octokit — so the integrations stay network-free and unit-testable.
 */
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tuning for {@link resolvePullDetail}: how hard to chase a lazily-computed merge state. */
export interface ResolvePullOpts {
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

  async getCombinedStatus(sha: string): Promise<GhCombinedStatus> {
    const { data } = await this.octokit.repos.getCombinedStatusForRef({ ...this.base, ref: sha });
    return { state: data.state, totalCount: data.total_count };
  }

  async listCheckRuns(sha: string): Promise<GhCheckRun[]> {
    const runs = await this.octokit.paginate(this.octokit.checks.listForRef, {
      ...this.base,
      ref: sha,
      per_page: 100,
    });
    return runs.map((run) => ({ status: run.status, conclusion: run.conclusion }));
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
    return { url: data.html_url };
  }

  async createIssueComment(number: number, body: string): Promise<GhCommentRef> {
    const { data } = await this.octokit.issues.createComment({ ...this.base, issue_number: number, body });
    return { url: data.html_url };
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
