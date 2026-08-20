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
  /**
   * Whether each review thread is **resolved** — the reviewer's own verdict on
   * whether their comment has been dealt with, and the only authoritative answer
   * to that question.
   *
   * Separate from {@link listPullReviewComments} because GitHub splits it that
   * way, not because we wanted two calls: resolution exists **only in GraphQL**
   * (`PullRequestReviewThread.isResolved`). The REST comments endpoint the other
   * method wraps returns no resolution state at all, which is the whole reason
   * `handled` was ever inferred from authorship.
   *
   * Threads are keyed by their root comment's `databaseId`, which is the same id
   * the REST endpoint returns — that shared key is what lets the two reads be
   * joined without a second notion of thread identity.
   */
  listPullReviewThreads(number: number): Promise<GhReviewThread[]>;
  /** Combined commit status for a head SHA (the legacy statuses API). */
  getCombinedStatus(sha: string): Promise<GhCombinedStatus>;
  /** Check-runs for a head SHA (the Checks API). */
  listCheckRuns(sha: string): Promise<GhCheckRun[]>;
  /**
   * A check run's failure **annotations** — the `{path, line, message}` triples
   * GitHub renders beside the diff. The cheap half of CI evidence: already
   * extracted, small, and one request.
   *
   * Empty for the large set of jobs that emit no `::error` and carry no problem
   * matcher, which is why {@link getJobLog} exists behind it rather than instead
   * of it. → [`src/ci/ciEvidence.ts`]
   */
  listCheckRunAnnotations(checkRunId: number): Promise<GhAnnotation[]>;
  /**
   * An Actions job's log, as text.
   *
   * **The whole log.** The endpoint answers with a redirect to a blob and honours
   * no line range, so a "tail" is a full download that is then mostly discarded —
   * the reason the annotation read above is tried first. Callers take the tail
   * themselves. Throws when the job has expired out of retention (GitHub keeps
   * logs far less long than it keeps the check run that names them).
   */
  getJobLog(jobId: number): Promise<string>;

  /** Open issues, optionally narrowed to a label. Includes PRs — caller filters them out. */
  listOpenIssues(label?: string): Promise<GhIssue[]>;
  /**
   * Issues in **either** state that GitHub last saw change at or after `since`,
   * optionally narrowed to a label. Includes PRs — caller filters them out.
   *
   * The mirror's read (issue #329), and the only place the harness asks GitHub for
   * a closed issue. `since` filters on *updated* rather than created, which is what
   * lets a sweep ask for the little that has moved instead of re-listing the
   * tracker; it is also why the mirror's one-month floor is a floor rather than a
   * cut, since an older item touched inside the window comes back too.
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
  /** Add (`present`) or remove a label on a PR. PRs are issues for the labels API. Idempotent. */
  setPullLabel(number: number, label: string, present: boolean): Promise<void>;
  /** Add (`present`) or remove a label on an issue — the watch/ignore toggle. Idempotent. */
  setIssueLabel(number: number, label: string, present: boolean): Promise<void>;
  /**
   * Open an issue. Returns the new number.
   *
   * Labels and the assignee ride on the **create**, not on follow-up writes: an
   * item that exists for a moment unlabelled is an item the watch gate can miss and
   * a filing nobody is assigned, and GitHub accepts both fields on the create call
   * so there is no reason to pay two requests for a weaker guarantee (issue #394).
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
   * Merge the base branch into a pull request that is behind it —
   * `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch`, GitHub's own server-side
   * merge. Throws when GitHub refuses (a branch that has moved on under us, a
   * conflict it did not report, a repository that forbids the write).
   */
  updatePullBranch(number: number): Promise<void>;
  /**
   * Delete a branch. Returns whether a ref was actually removed: `false` means it
   * was already gone, which the reap treats as success (see {@link ActionSink.deleteBranch}).
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
  /**
   * `merge_commit_sha` — the commit the merge produced on the base branch, and the
   * only report of it anything gets. Null on a PR closed without merging, and on
   * one GitHub has not finished computing it for.
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
}

/**
 * A review thread's resolution state, joined to {@link GhReviewComment} on the
 * root comment's id. Only what REST cannot answer — the comments themselves stay
 * on the REST read, so a GraphQL failure costs the verdict and not the thread.
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
   * The individual statuses behind `state`, named by their context. Carried so
   * per-check CI policy can act on *which* one failed; `state` stays the fold
   * every existing gate reads. Absent on a fixture that predates it.
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
   * addresses. Optional in the same sense as {@link GhCombinedStatus.statuses}:
   * the real API always sends one, and a fixture that predates evidence does
   * not. Absent means no {@link CiCheck.evidenceRef}, i.e. today's prompt.
   */
  id?: number;
  /**
   * `details_url`. Carried for one reason: an Actions check run's log lives under
   * a **job** id, which is not this check run's id and appears nowhere else in the
   * payload — only in this URL's `/job/<id>` segment. A check run from any other
   * app points somewhere with no log API at all, which is why parsing it is
   * allowed to fail and yield no log rather than being treated as an error.
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
