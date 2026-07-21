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
      headSha: p.head.sha,
      authorLogin: p.user?.login ?? '',
      url: p.html_url,
    }));
  }

  async getPull(number: number): Promise<GhPullDetail> {
    const { data } = await this.octokit.pulls.get({ ...this.base, pull_number: number });
    return { mergeable: data.mergeable, merged: data.merged };
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
      return { event: ev.event ?? '', sourcePrNumber };
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
}
