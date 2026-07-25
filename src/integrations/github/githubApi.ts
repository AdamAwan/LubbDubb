import type { MergeMethod } from '../../sink/actionSink.js';

/**
 * The narrow GitHub network seam.
 *
 * Only the operations the two GitHub integrations actually use live here — not
 * the whole GitHub surface. This is the boundary that isolates network I/O: the
 * real {@link OctokitGitHubApi} wraps one `Octokit` instance, and tests inject a
 * scripted fake, so the mapping logic in the integrations is exercised without a
 * single HTTP request (mirroring the repo's `FakePtyBackend` / `streamSpawner`
 * fakes).
 *
 * Every method is scoped to one already-bound `owner`/`repo`; the payload types
 * are minimal structural shapes describing only the fields we read, so octokit's
 * enormous generated types don't leak across the codebase.
 */
export interface GitHubApi {
  /** The authenticated login. Used to decide whether a review thread is "handled". */
  viewerLogin(): Promise<string>;

  /** Open PRs in the repo (list endpoint — note: `mergeable` is NOT populated here). */
  listOpenPulls(): Promise<GhPullSummary[]>;
  /**
   * PRs closed (merged or not) at or after `since`, newest activity first.
   *
   * Summary-only by design: a closed PR gets no review/check/comment fan-out, so
   * this stays one paginated call rather than O(closed PRs) requests. The
   * implementation stops paginating at the first page that falls out of the
   * window, so a repo closing fewer than a page of PRs in the window costs
   * exactly one request per snapshot.
   */
  listRecentlyClosedPulls(since: string): Promise<GhClosedPull[]>;
  /** Single-PR detail, the only place `mergeable`/`merged` are populated. */
  getPull(number: number): Promise<GhPullDetail>;
  listPullReviews(number: number): Promise<GhReview[]>;
  listPullReviewComments(number: number): Promise<GhReviewComment[]>;
  /** Combined commit status for a head SHA (the legacy statuses API). */
  getCombinedStatus(sha: string): Promise<GhCombinedStatus>;
  /** Check-runs for a head SHA (the Checks API). */
  listCheckRuns(sha: string): Promise<GhCheckRun[]>;

  /** Open issues, optionally narrowed to a label. Includes PRs — caller filters them out. */
  listOpenIssues(label?: string): Promise<GhIssue[]>;
  /** Timeline events for an issue, used to find the PR that references/closes it. */
  listIssueTimeline(number: number): Promise<GhTimelineEvent[]>;

  /** Reply threaded under an existing review comment. */
  createPullReviewReply(number: number, inReplyTo: number, body: string): Promise<GhCommentRef>;
  /** Top-level comment on a PR or issue (PRs are issues for the comments API). */
  createIssueComment(number: number, body: string): Promise<GhCommentRef>;
  /** Edit an existing issue comment in place, by its comment id. */
  updateIssueComment(commentId: number, body: string): Promise<GhCommentRef>;
  mergePull(number: number, method: MergeMethod): Promise<GhMergeResult>;
  /** Add (`present`) or remove a label on a PR. PRs are issues for the labels API. Idempotent. */
  setPullLabel(number: number, label: string, present: boolean): Promise<void>;
  /** Add (`present`) or remove a label on an issue — the watch/ignore toggle. Idempotent. */
  setIssueLabel(number: number, label: string, present: boolean): Promise<void>;
}

export interface GhPullSummary {
  number: number;
  title: string;
  /** head.ref */
  branch: string;
  /** base.ref — the branch this PR merges into. */
  baseBranch: string;
  /** head.sha — the commit CI runs against. */
  headSha: string;
  /** user.login of the PR author. */
  authorLogin: string;
  /** html_url. */
  url: string;
  /** Label names on the PR (the Issues/PR `labels` array). */
  labels: string[];
}

/**
 * A PR that has left the open set. Deliberately narrower than
 * {@link GhPullSummary}: nothing downstream reads CI, labels or a head SHA off a
 * dead PR, and not asking for them is what keeps the extra call cheap.
 */
export interface GhClosedPull {
  number: number;
  title: string;
  /** head.ref */
  branch: string;
  /** base.ref */
  baseBranch: string;
  /** user.login of the PR author — the `prAuthor` filter applies to closed PRs too. */
  authorLogin: string;
  /** html_url. */
  url: string;
  /** True when it was merged; false when it was closed without merging. */
  merged: boolean;
  /** closed_at — when it left the open set. */
  closedAt: string;
}

export interface GhPullDetail {
  /** GitHub tri-state: true / false / null (still computing). */
  mergeable: boolean | null;
  /** raw `mergeable_state`: clean | dirty | behind | blocked | unstable | ... | null. */
  mergeableState: string | null;
  merged: boolean;
}

export interface GhReview {
  reviewerLogin: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING */
  state: string;
  /** submitted_at, for ordering reviews into latest-per-reviewer. Null while pending. */
  submittedAt: string | null;
}

export interface GhReviewComment {
  id: number;
  authorLogin: string;
  body: string;
  /** in_reply_to_id — null for a thread root, the root's id for a reply. */
  inReplyToId: number | null;
}

export interface GhCombinedStatus {
  /** success | failure | error | pending; empty string when there are no statuses. */
  state: string;
  /** How many statuses rolled into `state`. Zero means "no signal". */
  totalCount: number;
}

export interface GhCheckRun {
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | skipped | stale | null */
  conclusion: string | null;
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** open | closed */
  state: string;
  url: string;
  /** True when this "issue" is really a PR (the Issues API returns both). */
  isPullRequest: boolean;
}

export interface GhTimelineEvent {
  /** cross-referenced | connected | disconnected | closed | labeled | unlabeled | ... */
  event: string;
  /** For a PR cross-reference/connection: the referencing PR's number; else null. */
  sourcePrNumber: number | null;
  /** For a `labeled`/`unlabeled` event: the label name; else null. The tag-authorship signal. */
  label: string | null;
  /** For a `labeled`/`unlabeled` event: the actor's login (who set/cleared it); else null. */
  actorLogin: string | null;
}

export interface GhCommentRef {
  url: string;
  /** The comment's own id — what an in-place edit addresses (the plan's status comment). */
  id: number;
}

export interface GhMergeResult {
  sha: string;
  merged: boolean;
}
