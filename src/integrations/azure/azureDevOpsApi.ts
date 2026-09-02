import type { AreaPathTree } from '../../intake/placement.js';
import type { MergeMethod } from '../../sink/actionSink.js';

/**
 * The narrow Azure DevOps network seam — the counterpart to {@link GitHubApi}.
 *
 * Only the operations the two Azure integrations actually use live here, not the
 * whole Azure DevOps REST surface. This is the boundary that isolates network
 * I/O: the real {@link RestAzureDevOpsApi} is the *only* file that speaks HTTP (and
 * resolves auth), and tests inject a scripted fake, so the mapping logic in the
 * integrations is exercised without a single request (mirroring the `github`
 * provider's `GitHubApi` seam).
 *
 * Every method is scoped to one already-bound `organization`/`project`/`repository`;
 * the payload types are minimal structural shapes describing only the fields we
 * read, so Azure's sprawling response shapes don't leak across the codebase.
 */
export interface AzureDevOpsApi {
  /** The authenticated identity's unique name (UPN). Used to decide whether a PR thread is "handled". */
  viewerUniqueName(): Promise<string>;

  /** Active pull requests in the repo (includes reviewer votes, mergeStatus, isDraft). */
  listActivePullRequests(): Promise<AzPull[]>;
  /**
   * Pull requests completed or abandoned at or after `since` — the counterpart to
   * {@link GitHubApi.listRecentlyClosedPulls}.
   *
   * Summary-only by design: no threads, policy evaluations or labels are fetched
   * for a closed PR, so this stays one bounded request per snapshot rather than
   * O(closed PRs).
   */
  listRecentlyClosedPullRequests(since: string): Promise<AzClosedPull[]>;
  /** Comment threads on a PR — the review-comment signal. */
  listPullThreads(pullRequestId: number): Promise<AzThread[]>;
  /**
   * Branch-policy evaluations for a PR — the authoritative required-checks signal.
   *
   * The PR *statuses* endpoint is the wrong source for "are the checks passing":
   * it returns every status ever posted across *all* iterations, so a single
   * stale `failed` from a superseded push poisons the PR forever. Policy
   * evaluations instead reflect only the current state of the policies that
   * actually apply to this PR, and mark which are `isBlocking` (i.e. required).
   */
  listPolicyEvaluations(pullRequestId: number): Promise<AzPolicyEvaluation[]>;
  /**
   * Requeue one policy evaluation — the write that starts a build for an
   * **expired** build-validation policy (issue #395).
   *
   * `PATCH _apis/policy/evaluations/{evaluationId}`, which is the endpoint Azure
   * exposes for exactly this and the reason the harness does not queue the build
   * definition itself: queueing a definition produces a build that is not
   * attached to this pull request's policy evaluation, so the gate would stay
   * expired while a build ran.
   *
   * Returns the record Azure answers with rather than nothing, because the call
   * succeeding and the requeue *happening* are different facts: Azure answers 200
   * for a policy it declines to restart, and the returned `isExpired` is the only
   * thing that tells them apart before the next snapshot.
   */
  requeuePolicyEvaluation(evaluationId: string): Promise<AzPolicyRequeue>;
  /**
   * A build's timeline: one record per stage/phase/job/task, each carrying its
   * result, its log id, and — the useful part — the `issues` the task raised.
   *
   * The cheap half of CI evidence, and the reason a failing Azure build rarely
   * needs its log at all: a task that failed an assertion reports it here as an
   * `error` issue, already extracted. → [`src/ci/ciEvidence.ts`]
   */
  getBuildTimeline(buildId: number): Promise<AzTimelineRecord[]>;
  /**
   * One build log's lines — the log of a single **task**, not of the whole build.
   *
   * That scoping is why no line range is asked for here even though the endpoint
   * offers one: a range needs a total line count to take a *tail* from, which
   * costs a second request, and one failed step's log is small enough that
   * fetching it whole and tailing locally is the cheaper of the two. The
   * per-task granularity is the real saving over GitHub, whose smallest unit is
   * the entire job.
   */
  getBuildLog(buildId: number, logId: number): Promise<string[]>;

  /** Label names on a PR — the exclusion-tag signal. */
  listPullLabels(pullRequestId: number): Promise<string[]>;

  /**
   * Open work items, optionally narrowed to a tag and/or an assignee (uniqueName/UPN).
   * Includes ArtifactLink relations.
   */
  listOpenWorkItems(tag?: string, assignedTo?: string): Promise<AzWorkItem[]>;
  /**
   * Work items in **any** state that Azure last saw change at or after `since`,
   * under the same tag/assignee narrowing as {@link listOpenWorkItems}.
   *
   * The ticket mirror's read (issue #329), and the only place the harness asks for
   * a closed work item. `System.ChangedDate` is what makes a sweep incremental —
   * and what makes the mirror's one-month floor a floor rather than a cut, since an
   * older item touched inside the window comes back on it too.
   */
  listWorkItemsChangedSince(since: string, tag?: string, assignedTo?: string): Promise<AzWorkItem[]>;
  /**
   * Read specific work items by id — how the *related* items are hydrated. The
   * open-item list is narrowed by tag/assignee, so an item's parent Feature is
   * usually not in it, and the relationship is only worth carrying if the thing
   * it points at can be read.
   *
   * Batched by the caller and capped by Azure at 200 ids per request, so a
   * snapshot's whole hierarchy costs a bounded number of calls rather than one per
   * item. Returns only the items that exist: a deleted or unreadable id is
   * dropped, never faulted, because one stale link must not cost the snapshot.
   */
  getWorkItems(ids: number[]): Promise<AzWorkItem[]>;
  /**
   * Revision history for a work item, narrowed to the System.Tags value before/after
   * each revision and who made it — the "who added this tag" signal for the ownership
   * gate. Fetched only when that gate is on, and only for items carrying the gate tag.
   */
  listWorkItemUpdates(id: number): Promise<AzWorkItemUpdate[]>;

  /** Reply threaded under an existing PR comment thread. */
  createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef>;
  /**
   * Set a comment thread's status — `fixed` for the harness resolving a thread on
   * an agent's say-so. Idempotent: a thread already in that status is a no-op.
   */
  setThreadStatus(pullRequestId: number, threadId: number, status: string): Promise<void>;
  /** Open a new top-level comment thread on a PR. */
  createThread(pullRequestId: number, content: string): Promise<AzCommentRef>;
  /** Complete (merge) a PR with the given strategy. `lastMergeSourceCommit` is required by Azure. */
  completePullRequest(
    pullRequestId: number,
    lastMergeSourceCommit: string,
    method: MergeMethod,
  ): Promise<AzMergeResult>;
  /** Add (`present`) or remove a label on a PR. Idempotent. */
  setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void>;

  /** Set a work item's `System.State` (e.g. "In Review"). Idempotent — a no-op when already there. */
  setWorkItemState(id: number, state: string): Promise<void>;

  /** Add a comment to a work item's discussion, returning its editable id. */
  createWorkItemComment(id: number, text: string): Promise<AzWorkItemCommentRef>;
  /** Edit an existing work-item comment in place. */
  updateWorkItemComment(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef>;

  /**
   * Hang a pull-request artifact link off a work item — the relation the **Check for
   * linked work items** branch policy reads, and the only thing on Azure that
   * satisfies it. A `#12` in the description does not; that is a GitHub convention
   * Azure never adopted.
   *
   * Idempotent: a link the work item already carries is a success, not an error.
   * Azure rejects the duplicate relation with a 400, which the implementation
   * absorbs — the harness's question is whether the link is there afterwards, and
   * it is.
   */
  linkWorkItemToPull(id: number, pullRequestId: number): Promise<void>;

  /**
   * Create a work item of `type`, returning its id (issue #394).
   *
   * The type is part of the URL, not a field: Azure has no untyped work item, so a
   * create without one is refused outright — which is exactly why the harness rather
   * than a model now decides it.
   *
   * Tags and the assignee ride on the same patch document as the title, so the item
   * is never briefly untagged: an item that exists for a moment without the watch tag
   * is one the pickup gate can miss.
   */
  createWorkItem(input: {
    type: string;
    title: string;
    description: string;
    tags: string[];
    assignedTo: string | null;
  }): Promise<{ id: number }>;
  /**
   * Hang a **related** link between two work items — the bug and the story it was
   * raised on.
   *
   * `related`, not parent/child: it is legal whatever process template the project
   * uses and changes neither item's rollup or board position, while a parent link
   * from a User Story to a Bug is refused outright where bugs are not managed at the
   * task level.
   *
   * Idempotent for {@link linkWorkItemToPull}'s reason and by the same absorption: a
   * relation the item already carries is a success.
   */
  relateWorkItem(id: number, relatedId: number): Promise<void>;
  /** Add (`present`) or remove a `System.Tags` entry on a work item — the watch/ignore toggle. Idempotent. */
  setWorkItemTag(id: number, tag: string, present: boolean): Promise<void>;
  /**
   * The project's classification tree: the root node, and every area beneath it.
   *
   * The one read on this seam that is about the *project* rather than about an
   * item, and it is here because there is nowhere else the harness could learn
   * it — an area path is a node in a tree only the provider holds, and the world
   * snapshot carries items, not schema. It is what lets the appraiser be **offered**
   * the areas rather than free-typing one, which is the difference between a
   * choice and an invented node that does not exist.
   *
   * The root is returned rather than left to be derived, for
   * {@link AreaPathTree}'s reason: on a project that has never subdivided, a root
   * and a leaf are the same string shape.
   */
  listAreaPaths(): Promise<AreaPathTree>;
  /**
   * Hang this item off `parentId` — the `System.LinkTypes.Hierarchy-Reverse`
   * relation, which is the only thing that makes a work item roll up to anything.
   *
   * Idempotent for {@link relateWorkItem}'s reason and by the same absorption: a
   * parent the item already carries is a success. Unlike that one this **is** a
   * hierarchy link and so is refused where the process template will not take it
   * (a Bug under a User Story where bugs are managed at the task level) — which
   * surfaces as a throw, and is the honest answer.
   */
  setWorkItemParent(id: number, parentId: number): Promise<void>;
  /** Move a work item onto a classification node — a patch on `System.AreaPath`. Idempotent. */
  setWorkItemAreaPath(id: number, areaPath: string): Promise<void>;
  /** Open a pull request. Branch names are plain here; the REST arm adds `refs/heads/`. */
  createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ pullRequestId: number }>;
  /** Rewrite a pull request's title — the naming convention. */
  setPullTitle(pullRequestId: number, title: string): Promise<void>;
  /** Retarget a pull request's base. Azure never does this itself when a rung merges. */
  setPullBase(pullRequestId: number, base: string): Promise<void>;
  /**
   * Delete a branch. Returns whether a ref was actually removed: `false` means it
   * was already gone, which the reap treats as success.
   */
  deleteBranch(branch: string): Promise<boolean>;
}

/** A work-item comment's own id — what an in-place edit addresses. */
export interface AzWorkItemCommentRef {
  id: number;
}

export interface AzPull {
  pullRequestId: number;
  title: string;
  /** source branch, `refs/heads/` stripped. */
  branch: string;
  /** target branch, `refs/heads/` stripped — the branch this PR merges into. */
  baseBranch: string;
  /** lastMergeSourceCommit.commitId — Azure requires it to complete the PR. */
  lastMergeSourceCommit: string;
  /** createdBy.uniqueName of the PR author. */
  authorUniqueName: string;
  /**
   * `createdBy.displayName` — the author as a person is *named*, which is what a
   * row saying somebody asked you for a review has to print. Empty when Azure
   * reports the identity without one; the UPN is the fallback, and a surface with
   * neither says nothing rather than a descriptor.
   */
  authorDisplayName: string;
  /** Web URL to the PR. */
  url: string;
  /** True while the PR is still a draft. */
  isDraft: boolean;
  /** mergeStatus: succeeded | conflicts | queued | rejectedByPolicy | failure | notSet. */
  mergeStatus: string;
  /**
   * Everyone Azure lists as a reviewer on the PR — votes *and* who cast them,
   * because the harness asks two different questions of this list: whether the PR
   * is approved (any vote), and whether **you personally** were asked for one.
   */
  reviewers: AzReviewer[];
}

/** One entry of a PR's reviewer list. */
export interface AzReviewer {
  /** `uniqueName` (a UPN) — empty when Azure reports an identity without one. */
  uniqueName: string;
  /** 10 approved, 5 approved-with-suggestions, 0 no vote, -5 waiting, -10 rejected. */
  vote: number;
  /** Azure's "required reviewer" flag; false is an optional one. */
  isRequired: boolean;
  /**
   * The entry is a **group**, not a person. Azure lists a team the same way it
   * lists an individual, and a policy that names a team puts every member of it
   * behind one row — so an operator inside that team is not somebody a person
   * asked, and reading the two alike would put every pull request in the project
   * on their queue.
   */
  isContainer: boolean;
}

/**
 * A PR that has left the active set. Narrower than {@link AzPull} on purpose:
 * merge status, reviewer votes and the head commit are meaningless once a PR is
 * closed, and not asking for them is what keeps the extra call cheap.
 */
export interface AzClosedPull {
  pullRequestId: number;
  title: string;
  /** source branch, `refs/heads/` stripped. */
  branch: string;
  /** target branch, `refs/heads/` stripped. */
  baseBranch: string;
  /** createdBy.uniqueName — the `prAuthor` filter applies to closed PRs too. */
  authorUniqueName: string;
  /** Web URL to the PR. */
  url: string;
  /** True when the PR completed (merged); false when it was abandoned. */
  merged: boolean;
  /** closedDate — when it left the active set. */
  closedAt: string;
  /**
   * `lastMergeCommit.commitId` — on a *completed* PR this is the commit Azure
   * created on the target branch, and the only report of it anything gets. Null on
   * an abandoned PR, whose `lastMergeCommit` is the trial merge and belongs to no
   * branch.
   */
  mergeCommitSha: string | null;
}

export interface AzThread {
  id: number;
  /** active | fixed | wontFix | closed | byDesign | pending | unknown | null. */
  status: string | null;
  /**
   * The file the thread hangs on and the line in it, from `threadContext`, or
   * null where Azure reports none — a thread on the pull request itself rather
   * than on the diff. Display only; nothing dispatches on either. Optional on the
   * type so a fixture written before them still describes a thread.
   */
  filePath?: string | null;
  line?: number | null;
  comments: AzComment[];
}

interface AzComment {
  id: number;
  authorUniqueName: string;
  content: string;
  /** null for a thread's root comment, the parent's id for a reply. */
  parentCommentId: number | null;
  /** text | system | codeChange | unknown — system comments are noise, callers drop them. */
  commentType: string;
}

export interface AzPolicyEvaluation {
  /**
   * The evaluation's own id — the handle a **requeue** is addressed to
   * ({@link AzureDevOpsApi.requeuePolicyEvaluation}), and the only thing on the
   * record that identifies this evaluation rather than the policy behind it.
   *
   * Optional because it is read from the wire like everything else here, and a
   * response without one leaves the harness with nothing to requeue — which is a
   * check rule `pr-ci-gate` dispatches an agent for, exactly as it did before the
   * direct path existed.
   */
  evaluationId?: string;
  /**
   * The policy configuration's well-known type GUID (stable across every org).
   * Identifies build-validation vs status vs required-reviewers vs … so callers
   * can keep `ciStatus` to *automated* checks only.
   */
  typeId: string;
  /**
   * The policy's operator-facing name, resolved through every place a policy
   * type happens to carry one (see `policyDisplayName`). Carried so per-check CI
   * policy can act on *which* check failed.
   */
  displayName: string;
  /**
   * Other names the same policy answers to, carried onto `CiCheck.aliases` so a
   * `ci.checks` glob claims the check whichever of them the operator wrote. A
   * status policy's `settings.defaultDisplayName` is the case: the label Azure
   * shows on the pull request page, which is not the `statusGenre/statusName` key
   * {@link displayName} resolves to (see `policyDisplayAliases`).
   */
  displayAliases?: string[];
  /**
   * The policy *type*'s own display name ("Build", "Comment requirements",
   * "Work item linking"). Carried because it classifies the evaluation for the
   * operator and is the last-resort name for a policy whose settings carry none.
   */
  typeName: string;
  /**
   * The build definition a build-validation evaluation ran, from its `context`.
   * The real name of most build policies: `settings.displayName` is null unless
   * an operator typed one, and a nameless check cannot be matched by a glob.
   */
  buildDefinitionName?: string;
  /** queued | running | approved | rejected | notApplicable | broken | null. */
  status: string | null;
  /**
   * `context.buildId` on a build-validation evaluation: the build whose failure a
   * CI-fix agent is being sent to fix, and the handle its timeline and logs are
   * read through ({@link AzureDevOpsApi.getBuildTimeline}).
   *
   * Only build-validation policies have one. A **status** policy names an
   * external system through an arbitrary URL and has no build, no timeline and
   * no log — the same permanent absence a GitHub commit status has, rather than
   * something left unwired. → [`src/ci/ciEvidence.ts`]
   */
  buildId?: number;
  /**
   * `context.isExpired` on a build-validation evaluation: the last build ran
   * against commits this branch has since moved past, so the evaluation is
   * `queued` with **nothing in flight**. It never resolves until a build is
   * queued for the current head.
   *
   * Carried because it is the one thing that distinguishes that state from a
   * build genuinely running, which Azure reports with the same `status`. Dropping
   * it at this boundary is what parked pull requests reading "CI is still
   * running" indefinitely.
   */
  isExpired?: boolean;
  /** True when the policy blocks completion — i.e. a *required* check. */
  isBlocking: boolean;
  /** False when the policy is disabled; a disabled policy's evaluation is noise. */
  isEnabled: boolean;
}

/**
 * What a requeue came back as — the evaluation record, narrowed to the two fields
 * that say whether the requeue took.
 */
export interface AzPolicyRequeue {
  /** queued | running | approved | rejected | notApplicable | broken | null. */
  status: string | null;
  /** `context.isExpired` again: still true means Azure changed nothing. */
  isExpired?: boolean;
}

/** One node of a build's timeline — a stage, phase, job or task. */
export interface AzTimelineRecord {
  /** Stage | Phase | Job | Task — callers keep the tasks, which are what fail. */
  type: string;
  /** The step's display name, e.g. "Run tests". */
  name: string;
  /** succeeded | failed | canceled | skipped | succeededWithIssues | null (still running). */
  result: string | null;
  /** `log.id` — the handle {@link AzureDevOpsApi.getBuildLog} reads. Null when the step wrote none. */
  logId: number | null;
  /** The errors and warnings this step raised. Callers keep the errors. */
  issues: AzTimelineIssue[];
}

/** One error or warning a build step raised, as Azure already extracted it. */
interface AzTimelineIssue {
  /** error | warning. */
  type: string;
  message: string;
}

export interface AzWorkItem {
  id: number;
  title: string;
  /** System.Description — may be empty or HTML. */
  body: string;
  /** System.State — New | Active | Resolved | Closed | Done | Removed | ... */
  state: string;
  /** System.WorkItemType — Feature | Epic | User Story | Bug | Task | ... */
  workItemType: string;
  /** System.Tags, split into a list. */
  tags: string[];
  /**
   * `System.AreaPath` — the classification node the item sits on, which is what
   * puts it on a team's board.
   *
   * Always present on a real work item: an item nobody has classified sits on the
   * project root, so this is never empty and "unclassified" is a comparison
   * against the root rather than an absence (`src/intake/placement.ts`).
   */
  areaPath: string;
  /** ArtifactLink relation urls (e.g. `vstfs:///Git/PullRequestId/{project}%2F{repo}%2F{id}`). */
  relationUrls: string[];
  /**
   * The id this item hangs off, from its `System.LinkTypes.Hierarchy-Reverse`
   * relation — the Feature a story or bug belongs to. Null when it has none.
   * Azure permits at most one parent, so this is a single id rather than a list.
   */
  parentId: number | null;
  /** The ids hanging off this item (`…Hierarchy-Forward`) — a Feature's stories. */
  childIds: number[];
  /** Web URL to the work item. */
  url: string;
  /** System.CreatedDate — the ticket mirror's `added` reading. */
  createdAt: string;
  /** System.ChangedDate — the instant the mirror's next sweep asks from. */
  changedAt: string;
}

export interface AzWorkItemUpdate {
  /** revisedBy.uniqueName — the identity that made this revision. */
  revisedByUniqueName: string;
  /** System.Tags value before this revision (semicolon-delimited); absent when tags didn't change. */
  tagsOld?: string;
  /** System.Tags value after this revision; absent when tags didn't change. */
  tagsNew?: string;
}

export interface AzCommentRef {
  url: string;
}

export interface AzMergeResult {
  /** The PR status after the completion request: completed | queued | active | abandoned. */
  status: string;
}
