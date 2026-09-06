import type { MergeMethod } from '../../sink/actionSink.js';

/**
 * The narrow GitHub network seam: only the operations the two GitHub integrations
 * use, all scoped to one already-bound `owner`/`repo`. Tests inject a scripted
 * fake here, so extending this interface means extending that fake in the same
 * change. → `docs/spec/15-integrations.md`
 */
export interface GitHubApi {
  /** The authenticated login. Used to decide whether a review thread is "handled". */
  viewerLogin(): Promise<string>;

  /** Open PRs in the repo (list endpoint — note: `mergeable` is NOT populated here). */
  listOpenPulls(): Promise<GhPullSummary[]>;
  /**
   * PRs closed (merged or not) at or after `since`, newest activity first.
   * Summary-only; paginating stops at the first page outside the window, so
   * this stays one request per snapshot in the common case.
   */
  listRecentlyClosedPulls(since: string): Promise<GhClosedPull[]>;
  /** Single-PR detail, the only place `mergeable`/`merged` are populated. */
  getPull(number: number): Promise<GhPullDetail>;
  listPullReviews(number: number): Promise<GhReview[]>;
  listPullReviewComments(number: number): Promise<GhReviewComment[]>;
  /**
   * Whether each review thread is **resolved**. Separate from
   * {@link listPullReviewComments} because resolution exists only in GraphQL;
   * the two reads join on the root comment's `databaseId`.
   */
  listPullReviewThreads(number: number): Promise<GhReviewThread[]>;
  /**
   * Mark a review thread resolved, keyed on the root comment's database id.
   * Answers `false` when no thread has that root (stale, not a fault); idempotent.
   */
  resolveReviewThread(number: number, rootCommentId: number): Promise<boolean>;
  /** Combined commit status for a head SHA (the legacy statuses API). */
  getCombinedStatus(sha: string): Promise<GhCombinedStatus>;
  /** Check-runs for a head SHA (the Checks API). */
  listCheckRuns(sha: string): Promise<GhCheckRun[]>;
  /**
   * A check run's failure **annotations** — the cheap half of CI evidence. Empty
   * for jobs with no `::error` and no problem matcher, which is why
   * {@link getJobLog} exists behind it. → [`src/ci/ciEvidence.ts`]
   */
  listCheckRunAnnotations(checkRunId: number): Promise<GhAnnotation[]>;
  /**
   * An Actions job's log, as text — the whole log: no line range, so callers
   * take the tail themselves. Throws when the job has expired out of retention.
   */
  getJobLog(jobId: number): Promise<string>;

  /** Open issues, optionally narrowed to a label. Includes PRs — caller filters them out. */
  listOpenIssues(label?: string): Promise<GhIssue[]>;
  /**
   * Issues in **either** state that GitHub last saw change at or after `since`,
   * optionally narrowed to a label. Includes PRs — caller filters them out. The
   * mirror's read, and the only place the harness asks for a closed issue.
   */
  listIssuesChangedSince(since: string, label?: string): Promise<GhIssue[]>;
  /** Timeline events for an issue, used to find the PR that references/closes it. */
  listIssueTimeline(number: number): Promise<GhTimelineEvent[]>;

  /** Reply threaded under an existing review comment. */
  createPullReviewReply(number: number, inReplyTo: number, body: string): Promise<GhCommentRef>;
  /** Top-level comment on a PR or issue (PRs are issues for the comments API). */
  createIssueComment(number: number, body: string): Promise<GhCommentRef>;
  /** Edit an existing issue comment in place, by its comment id. */
  updateIssueComment(commentId: number, body: string): Promise<GhCommentRef>;
  mergePull(number: number, method: MergeMethod): Promise<GhMergeResult>;
  /**
   * Close a pull request without merging it. Idempotent. GitHub carries no
   * close *reason* for a PR the way it does for an issue, unlike {@link closeIssue}.
   */
  closePull(number: number): Promise<void>;
  /** Add (`present`) or remove a label on a PR. PRs are issues for the labels API. Idempotent. */
  setPullLabel(number: number, label: string, present: boolean): Promise<void>;
  /** Add (`present`) or remove a label on an issue — the watch/ignore toggle. Idempotent. */
  setIssueLabel(number: number, label: string, present: boolean): Promise<void>;
  /**
   * Close an issue, with the reason GitHub draws on the timeline —
   * `not_planned` reads very differently from `completed`. Idempotent.
   */
  closeIssue(number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  /**
   * Open an issue. Returns the new number. Labels and the assignee must ride
   * on the create, never a follow-up write — an item unlabelled for a moment
   * is one the watch gate can miss.
   */
  createIssue(input: { title: string; body: string; labels: string[]; assignee: string | null }): Promise<{
    number: number;
  }>;
  /** Open a pull request. Returns the new number. */
  createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ number: number }>;
  /** Rewrite a pull request's title — the naming convention. */
  setPullTitle(number: number, title: string): Promise<void>;
  /** Retarget a pull request's base — a stack rung whose parent merged. */
  setPullBase(number: number, base: string): Promise<void>;
  /**
   * Merge the base branch into a PR that is behind it — GitHub's own
   * server-side merge. Throws when GitHub refuses (branch moved, unreported
   * conflict, forbidden write).
   */
  updatePullBranch(number: number): Promise<void>;
  /**
   * Delete a branch. Returns whether a ref was actually removed: `false` means
   * it was already gone, which the reap treats as success.
   */
  deleteBranch(branch: string): Promise<boolean>;
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
  /**
   * `assignees[].login` — who a person put the pull request on. Deliberately
   * not `requested_reviewers`, a different obligation shared by the whole org
   * on a team review rule.
   */
  assigneeLogins: string[];
  /**
   * `updated_at` — the change token the hydration cache gates the per-PR
   * fan-out on. Absent means a full re-hydration every pulse. Does not cover
   * CI: those reads gate on `head.sha` instead.
   */
  updatedAt?: string;
}

/**
 * A PR that has left the open set. Narrower than {@link GhPullSummary} —
 * nothing downstream reads CI, labels or a head SHA off a dead PR.
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
  /**
   * `merge_commit_sha` — the commit the merge produced on the base branch.
   * Null on a PR closed without merging, or one GitHub hasn't computed it for.
   */
  mergeCommitSha: string | null;
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
  /**
   * The file the comment hangs on, and the line in it. Display only, both
   * optional — a comment with no line carries neither.
   */
  path?: string;
  line?: number | null;
}

/**
 * A review thread's resolution state, joined to {@link GhReviewComment} on the
 * root comment's id — only what REST cannot answer, so a GraphQL failure costs
 * the verdict and not the thread.
 */
export interface GhReviewThread {
  /** `databaseId` of the thread's first comment — the same id REST calls `id`. */
  rootCommentId: number;
  isResolved: boolean;
}

export interface GhCombinedStatus {
  /** success | failure | error | pending; empty string when there are no statuses. */
  state: string;
  /** How many statuses rolled into `state`. Zero means "no signal". */
  totalCount: number;
  /**
   * The individual statuses behind `state`, named by their context, so per-check
   * CI policy can act on *which* one failed. Absent on a fixture predating it.
   */
  statuses?: Array<{ context: string; state: string }>;
}

export interface GhCheckRun {
  /** The check's display name, e.g. "lint", "test (18)". */
  name: string;
  /** queued | in_progress | completed */
  status: string;
  /** success | failure | neutral | cancelled | timed_out | action_required | skipped | stale | null */
  conclusion: string | null;
  /**
   * The check run's own id — what {@link GitHubApi.listCheckRunAnnotations}
   * addresses. Absent on a fixture predating evidence; means no
   * {@link CiCheck.evidenceRef}.
   */
  id?: number;
  /**
   * `details_url`. An Actions check run's log lives under a job id found only
   * in this URL's `/job/<id>` segment. Parsing it is allowed to fail and yield no log.
   */
  detailsUrl?: string | null;
}

/** One failure annotation on a check run — the extracted assertion, with its place. */
export interface GhAnnotation {
  /** Repo-relative file the annotation is on, or `.github` for a workflow-level one. */
  path: string;
  startLine: number;
  /** failure | warning | notice — callers keep the failures. */
  level: string;
  message: string;
  /** The check's own short label for the annotation (e.g. the rule id). May be empty. */
  title: string;
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
  /** `created_at` — when the issue was filed. The ticket mirror's `added` reading. */
  createdAt: string;
  /** `updated_at` — the instant the mirror's next sweep asks from. */
  updatedAt: string;
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
