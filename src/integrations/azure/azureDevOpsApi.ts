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
  /** Comment threads on a PR — the review-comment signal. */
  listPullThreads(pullRequestId: number): Promise<AzThread[]>;
  /** PR statuses (build-validation / custom status posts) — the CI signal. */
  listPullStatuses(pullRequestId: number): Promise<AzStatus[]>;
  /** Label names on a PR — the exclusion-tag signal. */
  listPullLabels(pullRequestId: number): Promise<string[]>;

  /** Open work items, optionally narrowed to a tag. Includes ArtifactLink relations. */
  listOpenWorkItems(tag?: string): Promise<AzWorkItem[]>;

  /** Reply threaded under an existing PR comment thread. */
  createThreadReply(
    pullRequestId: number,
    threadId: number,
    parentCommentId: number,
    content: string,
  ): Promise<AzCommentRef>;
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
  /** Web URL to the PR. */
  url: string;
  /** True while the PR is still a draft. */
  isDraft: boolean;
  /** mergeStatus: succeeded | conflicts | queued | rejectedByPolicy | failure | notSet. */
  mergeStatus: string;
  /** Reviewer votes: 10 approved, 5 approved-with-suggestions, 0 no vote, -5 waiting, -10 rejected. */
  reviewerVotes: number[];
}

export interface AzThread {
  id: number;
  /** active | fixed | wontFix | closed | byDesign | pending | unknown | null. */
  status: string | null;
  comments: AzComment[];
}

export interface AzComment {
  id: number;
  authorUniqueName: string;
  content: string;
  /** null for a thread's root comment, the parent's id for a reply. */
  parentCommentId: number | null;
  /** text | system | codeChange | unknown — system comments are noise, callers drop them. */
  commentType: string;
}

export interface AzStatus {
  /** succeeded | failed | pending | notApplicable | notSet | error | null. */
  state: string | null;
  /**
   * Monotonic status id — Azure posts statuses append-only, so a higher id is a more
   * recent post. Used to pick the latest status per {@link context} when a check has
   * been re-posted across re-runs.
   */
  id?: number;
  /** genre/name identify the check; every re-post of the same check shares this context. */
  context?: { genre: string | null; name: string | null };
}

export interface AzWorkItem {
  id: number;
  title: string;
  /** System.Description — may be empty or HTML. */
  body: string;
  /** System.State — New | Active | Resolved | Closed | Done | Removed | ... */
  state: string;
  /** System.Tags, split into a list. */
  tags: string[];
  /** ArtifactLink relation urls (e.g. `vstfs:///Git/PullRequestId/{project}%2F{repo}%2F{id}`). */
  relationUrls: string[];
  /** Web URL to the work item. */
  url: string;
}

export interface AzCommentRef {
  url: string;
}

export interface AzMergeResult {
  /** The PR status after the completion request: completed | queued | active | abandoned. */
  status: string;
}
