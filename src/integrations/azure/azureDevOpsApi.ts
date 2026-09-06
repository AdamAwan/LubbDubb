import type { AreaPathTree } from '../../intake/placement.js';
import type { MergeMethod } from '../../sink/actionSink.js';

/**
 * The narrow Azure DevOps network seam — the counterpart to {@link GitHubApi}, and the
 * boundary that isolates network I/O: {@link RestAzureDevOpsApi} is the only file here that
 * speaks HTTP, and tests inject a scripted fake. → `docs/spec/15-integrations.md`
 */
export interface AzureDevOpsApi {
  /** The authenticated identity's unique name (UPN). */
  viewerUniqueName(): Promise<string>;

  /** Active pull requests in the repo (includes reviewer votes, mergeStatus, isDraft). */
  listActivePullRequests(): Promise<AzPull[]>;
  /** Pull requests completed or abandoned at or after `since`. */
  listRecentlyClosedPullRequests(since: string): Promise<AzClosedPull[]>;
  /** Comment threads on a PR — the review-comment signal. */
  listPullThreads(pullRequestId: number): Promise<AzThread[]>;
  /** Branch-policy evaluations for a PR — the authoritative required-checks signal. */
  listPolicyEvaluations(pullRequestId: number): Promise<AzPolicyEvaluation[]>;
  /**
   * Requeue one policy evaluation — the write that starts a build for an **expired**
   * build-validation policy. Never queue the build definition instead: that build is not
   * attached to this PR's evaluation, so the gate stays expired.
   */
  requeuePolicyEvaluation(evaluationId: string): Promise<AzPolicyRequeue>;
  /**
   * A build's timeline: one record per stage/phase/job/task, with its result, log id and
   * the `issues` it raised. → [`src/ci/ciEvidence.ts`]
   */
  getBuildTimeline(buildId: number): Promise<AzTimelineRecord[]>;
  /** One build log's lines — a single **task**'s log, not the whole build's. */
  getBuildLog(buildId: number, logId: number): Promise<string[]>;

  /** Label names on a PR — the exclusion-tag signal. */
  listPullLabels(pullRequestId: number): Promise<string[]>;

  /** Open work items, optionally narrowed to a tag and/or an assignee (uniqueName/UPN). */
  listOpenWorkItems(tag?: string, assignedTo?: string): Promise<AzWorkItem[]>;
  /**
   * Work items in **any** state Azure last saw change at or after `since`, under the same
   * narrowing as {@link listOpenWorkItems}.
   */
  listWorkItemsChangedSince(since: string, tag?: string, assignedTo?: string): Promise<AzWorkItem[]>;
  /**
   * Read specific work items by id — how the *related* items are hydrated, since the
   * open-item list is narrowed by tag/assignee. A deleted or unreadable id is dropped,
   * never faulted: one stale link must not cost the snapshot.
   */
  getWorkItems(ids: number[]): Promise<AzWorkItem[]>;
  /**
   * Revision history narrowed to the System.Tags value before/after each revision and who
   * made it — the "who added this tag" signal.
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
   * Set a comment thread's status — `fixed` for the harness resolving a thread on an
   * agent's say-so. Idempotent: a thread already in that status is a no-op.
   */
  setThreadStatus(pullRequestId: number, threadId: number, status: string): Promise<void>;
  /** Open a new top-level comment thread on a PR. */
  createThread(pullRequestId: number, content: string): Promise<AzCommentRef>;
  /** Complete (merge) a PR with the given strategy. */
  completePullRequest(
    pullRequestId: number,
    lastMergeSourceCommit: string,
    method: MergeMethod,
  ): Promise<AzMergeResult>;
  /**
   * Abandon a pull request — Azure's "closed without merging", which is a `status` patch
   * rather than a verb of its own.
   */
  abandonPullRequest(pullRequestId: number): Promise<void>;
  /** Add (`present`) or remove a label on a PR. */
  setPullLabel(pullRequestId: number, label: string, present: boolean): Promise<void>;

  /** Set a work item's `System.State` (e.g. Idempotent — a no-op when already there. */
  setWorkItemState(id: number, state: string): Promise<void>;

  /** Add a comment to a work item's discussion, returning its editable id. */
  createWorkItemComment(id: number, text: string): Promise<AzWorkItemCommentRef>;
  /** Edit an existing work-item comment in place. */
  updateWorkItemComment(id: number, commentId: number, text: string): Promise<AzWorkItemCommentRef>;

  /**
   * Hang a pull-request artifact link off a work item — the only thing that satisfies the
   * **Check for linked work items** policy; a `#12` in the description does not. →
   * `docs/spec/07-pull-requests.md#linking-the-work-item`
   */
  linkWorkItemToPull(id: number, pullRequestId: number): Promise<void>;

  /** Create a work item of `type`, returning its id. */
  createWorkItem(input: {
    type: string;
    title: string;
    description: string;
    tags: string[];
    assignedTo: string | null;
  }): Promise<{ id: number }>;
  /**
   * Hang a **related** link between two work items — the bug and the story it was raised
   * on.
   */
  relateWorkItem(id: number, relatedId: number): Promise<void>;
  /**
   * Add (`present`) or remove a `System.Tags` entry on a work item — the watch/ignore
   * toggle.
   */
  setWorkItemTag(id: number, tag: string, present: boolean): Promise<void>;
  /**
   * The project's classification tree: the root node and every area beneath it — the one
   * read on this seam about the *project* rather than an item, and what lets the appraiser
   * be offered the areas rather than free-type one.
   */
  listAreaPaths(): Promise<AreaPathTree>;
  /**
   * Hang this item off `parentId` — the `Hierarchy-Reverse` relation, the only thing that
   * makes a work item roll up.
   */
  setWorkItemParent(id: number, parentId: number): Promise<void>;
  /** Move a work item onto a classification node — a patch on `System.AreaPath`. */
  setWorkItemAreaPath(id: number, areaPath: string): Promise<void>;
  /** Open a pull request. */
  createPull(input: { head: string; base: string; title: string; body: string }): Promise<{ pullRequestId: number }>;
  /** Rewrite a pull request's title — the naming convention. */
  setPullTitle(pullRequestId: number, title: string): Promise<void>;
  /** Retarget a pull request's base. Azure never does this itself when a rung merges. */
  setPullBase(pullRequestId: number, base: string): Promise<void>;
  /** Delete a branch. */
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
  /** `createdBy.displayName`. */
  authorDisplayName: string;
  /** Web URL to the PR. */
  url: string;
  /** True while the PR is still a draft. */
  isDraft: boolean;
  /** mergeStatus: succeeded | conflicts | queued | rejectedByPolicy | failure | notSet. */
  mergeStatus: string;
  /**
   * Everyone Azure lists as a reviewer — votes *and* who cast them; the harness asks both
   * questions.
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
  /** The entry is a **group**, not a person. */
  isContainer: boolean;
}

/** A PR that has left the active set. */
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
   * `lastMergeCommit.commitId` — on a *completed* PR the commit Azure created on the target
   * branch.
   */
  mergeCommitSha: string | null;
}

export interface AzThread {
  id: number;
  /** active | fixed | wontFix | closed | byDesign | pending | unknown | null. */
  status: string | null;
  /** The file and line the thread hangs on, or null for a thread on the pull request itself. */
  filePath?: string | null;
  line?: number | null;
  /** Azure's `properties` bag, flattened from `{$type, $value}` envelopes to plain strings. */
  properties?: Record<string, string> | null;
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
   * The evaluation's own id — what a requeue is addressed to, and the only field that
   * identifies this evaluation rather than the policy behind it. Absent leaves the harness
   * with nothing to requeue, which rule `pr-ci-gate` dispatches an agent for.
   */
  evaluationId?: string;
  /**
   * The policy type's well-known GUID, so callers can keep `ciStatus` to *automated* checks
   * only.
   */
  typeId: string;
  /**
   * The policy's operator-facing name (see `policyDisplayName`), so per-check CI policy can
   * act on which failed.
   */
  displayName: string;
  /**
   * Other names the same policy answers to, carried onto `CiCheck.aliases` so a `ci.checks`
   * glob claims the check whichever one the operator wrote.
   */
  displayAliases?: string[];
  /** The policy *type*'s display name ("Build", "Work item linking") — the last-resort name. */
  typeName: string;
  /**
   * The build definition a build-validation evaluation ran — the real name of most build
   * policies.
   */
  buildDefinitionName?: string;
  /** queued | running | approved | rejected | notApplicable | broken | null. */
  status: string | null;
  /**
   * `context.buildId` — the handle a build's timeline and logs are read through. →
   * [`src/ci/ciEvidence.ts`]
   */
  buildId?: number;
  /**
   * `context.isExpired`: the last build ran against commits the branch has moved past, so
   * the evaluation is `queued` with **nothing in flight** and never resolves on its own.
   */
  isExpired?: boolean;
  /** True when the policy blocks completion — i.e. a *required* check. */
  isBlocking: boolean;
  /** False when the policy is disabled; a disabled policy's evaluation is noise. */
  isEnabled: boolean;
}

/** What a requeue came back as, narrowed to the two fields that say whether it took. */
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
  /** `log.id` — the handle {@link AzureDevOpsApi.getBuildLog} reads. */
  logId: number | null;
  /** The errors and warnings this step raised. */
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
  /** `System.AreaPath` — the node that puts the item on a team's board. */
  areaPath: string;
  /** ArtifactLink relation urls (e.g. `vstfs:///Git/PullRequestId/{project}%2F{repo}%2F{id}`). */
  relationUrls: string[];
  /**
   * The id this item hangs off (`Hierarchy-Reverse`) — the Feature a story or bug belongs
   * to, or null.
   */
  parentId: number | null;
  /** The ids hanging off this item (`…Hierarchy-Forward`) — a Feature's stories. */
  childIds: number[];
  /**
   * The ids this item **waits on** (`Dependency-Reverse`) — its Predecessors. Empty when it
   * waits on nothing.
   */
  dependsOnIds: number[];
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
  /**
   * System.Tags value before this revision (semicolon-delimited); absent when tags didn't
   * change.
   */
  tagsOld?: string;
  /** System.Tags value after this revision; absent when tags didn't change. */
  tagsNew?: string;
}

export interface AzCommentRef {
  url: string;
  /**
   * Azure's own id for the comment created — what attribution matches a reply on. →
   * `docs/spec/07-pull-requests.md#review-threads`
   */
  id?: number;
  /**
   * Azure's own id for the **thread** the comment landed in — a different number from
   * {@link id}, and the one a resolution is keyed on.
   */
  threadId?: number;
}

export interface AzMergeResult {
  /** The PR status after the completion request: completed | queued | active | abandoned. */
  status: string;
}
