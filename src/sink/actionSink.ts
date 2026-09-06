/**
 * The outbound seam — the mirror image of {@link Connector}. Every side-effectful
 * action the harness may take autonomously goes through this interface, so a real
 * provider adapter drops in without any other module changing.
 *
 * `FakeConnector` doubles as the sink, reflecting effects back into its own fake
 * world so nothing leaves the machine while the seam stays real.
 */

export interface PrReplyInput {
  prNumber: number;
  /** The review comment being answered, if this reply is threaded under one. */
  commentId: string | null;
  body: string;
}

export interface PrThreadResolveInput {
  prNumber: number;
  /**
   * The review thread to mark resolved — the same id a reply is threaded under
   * (`PrComment.id`), never a provider-native node id. Required: resolving is a
   * verdict on one thread, and there is no such thing as resolving a pull request.
   */
  commentId: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PrMergeInput {
  prNumber: number;
  /** How to land the branch. */
  method: MergeMethod;
}

/**
 * A pull request the operator is closing without merging it — the plan part restart
 * (`src/plans/partRestart.ts`). The number alone: neither provider has a
 * close-reason vocabulary for a PR, so the account of why belongs in a comment.
 */
export interface PrCloseInput {
  prNumber: number;
}

export interface PrLabelInput {
  prNumber: number;
  /** The label to add or remove. */
  label: string;
  /** True to add the label, false to remove it. Idempotent either way. */
  present: boolean;
}

export interface PrCreateInput {
  /** The head branch — the work. */
  branch: string;
  /** The branch this PR targets: the default branch, or the rung beneath it in a stack. */
  base: string;
  title: string;
  body: string;
}

export interface PrTitleInput {
  prNumber: number;
  title: string;
}

export interface PrBaseInput {
  prNumber: number;
  /** The branch the PR should target. Retarget-on-merge writes the merged rung's own base here. */
  base: string;
}

export interface PrBaseUpdateInput {
  prNumber: number;
  /** The base branch being merged in. Not sent to the provider — it names the act in the audit line. */
  base: string;
}

export interface CiCheckRequeueInput {
  /** The pull request the gate sits on. For the audit line, not for the provider. */
  prNumber: number;
  /** The check's operator-facing name — what the audit line and the fallback prompt call it. */
  check: string;
  /** The provider's own handle for queueing a fresh run — `CiCheck.requeueRef`, opaque here. */
  requeueRef: string;
}

export interface BranchDeleteInput {
  /** The branch to delete, plain — each provider adds its own `refs/heads/` prefix. */
  branch: string;
}

export interface WorkItemStateInput {
  /** The work item / issue number to transition. */
  number: number;
  /** The provider-native state to move it to (e.g. Azure "In Review"). */
  state: string;
}

export interface WorkItemLinkInput {
  /** The work item / issue number the link hangs off. */
  number: number;
  /** The pull request it is linked to. */
  prNumber: number;
}

/**
 * Where a tracker item sits on the backlog — the container it rolls up to, and the
 * node that puts it on a team's board (`src/intake/placement.ts`). Two inputs
 * rather than one, since they are two provider writes settled one at a time.
 */
export interface WorkItemParentInput {
  /** The item being re-parented. */
  number: number;
  /** The container it should hang off. */
  parentNumber: number;
}

export interface WorkItemAreaPathInput {
  number: number;
  /** The provider-native classification node, exactly as the provider stated it. */
  areaPath: string;
}

export interface IssueLabelInput {
  /** The issue / work item number to label. */
  number: number;
  /** The label (tag) to add or remove — the watch/ignore tag. */
  label: string;
  /** True to add the label, false to remove it. Idempotent either way. */
  present: boolean;
}

/**
 * A tracker item the harness is creating — the outbound half of a filing. Everything
 * a create needs is an argument here, never a sentence in a prompt. `type` and
 * `relatedTo` are provider-native, not provider-specific: each adapter expresses
 * them in its own vocabulary or ignores them.
 */
export interface IssueCreateInput {
  title: string;
  body: string;
  /** Labels / tags applied as it is created — the watch label, the bug label. */
  labels: string[];
  /** The provider-native item type, or null where the caller has no opinion. */
  type: string | null;
  /** Who it belongs to (a GitHub login, an Azure UPN), or null to leave it unassigned. */
  assignee: string | null;
  /** A tracker item this one is *related* to — the bug/story edge. Null for none. */
  relatedTo: number | null;
}

/**
 * A tracker item the harness is closing without doing the work — the plan
 * back-out's "this is not really an issue". `reason` is the provider's own
 * vocabulary, not prose, and is deliberately the only field beyond the number.
 */
export interface IssueCloseInput {
  /** The issue / work item to close. */
  number: number;
  /** Why it closed, in the two readings every tracker distinguishes. */
  reason: 'completed' | 'not_planned';
}

export interface IssueCommentInput {
  /** The issue / work item to comment on. */
  number: number;
  body: string;
  /**
   * The provider comment id to edit in place, or null to create one. A plan keeps a
   * single living status comment rather than a stream, so this is the id the last
   * write returned (persisted on `plans.status_comment_ref`).
   */
  commentRef: string | null;
}

/**
 * Where a filing would land and who it would be filed by, asked live rather than
 * read off config — config cannot say whether the credential still works. Resolved
 * by a real provider call and throws when the provider will not answer.
 */
export interface FilingTarget {
  /** The destination in the provider's own vocabulary — `octo/demo`, `contoso/Web`. */
  target: string;
  /** Who the credential authenticates as, or null where the provider has no such notion. */
  identity: string | null;
}

export interface SendResult {
  ok: boolean;
  /** A provider-side reference for the sent artifact (e.g. a comment id/URL), for the audit log. */
  ref?: string;
  /**
   * The provider's own id for a comment this call created, in the vocabulary the
   * read side puts on `PrThreadMessage.id`. Separate from {@link ref}, a clickable
   * URL that matches nothing on a read. Absent when the provider will not name what
   * it created; the harness must not fall back to the author then — the thread
   * stays unanswered and the miss is recorded. → `docs/spec/07-pull-requests.md#review-threads`
   */
  commentRef?: string;
  /**
   * The provider's own id for the thread this send landed in, in the vocabulary the
   * read side puts on `PrReviewThread.id`. Separate from {@link commentRef}: on
   * Azure those are different numbers. Absent where the provider will not name the
   * thread, or has no threads at all (GitHub).
   */
  threadRef?: string;
}

export interface ActionSink {
  /** Post a reply on a pull request. Throws if the send fails. */
  postPrReply(input: PrReplyInput): Promise<SendResult>;
  /** Whether any configured integration can resolve a review thread at all — an agent must be told which happened, never left believing a thread is shut when it is still open. */
  canResolvePrThread(): boolean;
  /** Mark a review thread resolved. Idempotent: already-resolved is a success. `ok: false` means the provider has no such thread (a stale reading, not a fault); throws when the operation failed. */
  resolvePrThread(input: PrThreadResolveInput): Promise<SendResult>;
  /** Merge a pull request (the last step of the issue → PR → merge loop). Throws if the merge fails. */
  mergePr(input: PrMergeInput): Promise<SendResult>;
  /**
   * Whether any configured integration can close a pull request at all. The plan
   * sheet's "restart this part" offers the operation; where nothing implements it
   * the restart is refused whole, since taking the part to `ready` while the
   * still-open PR remains would put it straight back to `in_review`.
   */
  canClosePr(): boolean;
  /**
   * Close a pull request without merging it. Idempotent, so a restart is safe to
   * press twice; throws if it fails, including where nothing implements it (hence
   * {@link canClosePr}). Never called by a rule — only because a person said so.
   * → `docs/spec/08-planning.md#restarting-a-part`
   */
  closePr(input: PrCloseInput): Promise<SendResult>;
  /** Add/remove a label on a PR — the operator's exclusion tag toggle. Throws if it fails. */
  setPrLabel(input: PrLabelInput): Promise<SendResult>;
  /** Add/remove a label on an issue / work item — the cockpit's watch/ignore toggle. Throws if it fails. */
  setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
  /** Whether any configured integration can close a tracker item at all. Where false, the plan back-out still comments, concludes and un-watches, leaving the transition as a human act. */
  canCloseIssue(): boolean;
  /**
   * Close a tracker item — the plan back-out's "this is not really an issue".
   * Idempotent: closing an already-closed item is a success. Throws if it fails,
   * including where nothing implements it, which is why {@link canCloseIssue} exists.
   */
  closeIssue(input: IssueCloseInput): Promise<SendResult>;
  /** Whether any configured integration can write a work item's state at all. {@link setWorkItemState} throws when nothing implements it; the cockpit's board draws no drag where this is false. GitHub issues answer false. */
  canSetWorkItemState(): boolean;
  /**
   * Move a work item to a provider-native state (e.g. Azure "In Review" once a PR
   * is open), so it stops being re-picked while under review. Idempotent. Throws if
   * it fails. Only providers with a rich state model implement it.
   */
  setWorkItemState(input: WorkItemStateInput): Promise<SendResult>;
  /** Whether any configured integration can place a work item at all — set its parent and area path. Where false, the placement feature is absent rather than broken. GitHub issues answer false. */
  canPlaceWorkItem(): boolean;
  /** Hang a work item off its container — the relation that makes it roll up to anything. Idempotent. Throws if it fails, including where the process template refuses the link. */
  setWorkItemParent(input: WorkItemParentInput): Promise<SendResult>;
  /** Move a work item onto a classification node — what puts it on a board. Idempotent. Throws if it fails. */
  setWorkItemAreaPath(input: WorkItemAreaPathInput): Promise<SendResult>;
  /**
   * Create or update a comment on an issue / work item — the plan's status comment,
   * the one progress channel both providers share. `ref` on the result is the
   * provider comment id, so the next write edits rather than re-posts. Throws if it
   * fails. Only providers with a comment API implement it.
   */
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult>;
  /**
   * Create a tracker item — the harness filing its own rather than composing a
   * `gh`/`az` command for an agent to run. `ref` on the result is the new item in
   * the harness's own vocabulary (`issue:314`), never a provider id. Throws on
   * failure; there is no `ok: false` arm.
   */
  createIssue(input: IssueCreateInput): Promise<SendResult>;
  /**
   * Link a work item to the pull request that resolves it — the tracker-side
   * relation, not a mention in prose. `ok: false` is "this provider does not need
   * it", not a failure (GitHub links from the body's `#12`); throws only when the
   * provider has the operation and it failed. Idempotent.
   */
  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult>;
  /** Open a pull request. `ref` on the result is the new PR number. Throws if creation fails. Never replaces an agent opening one itself, which stays the floor when the tool channel is off. */
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
  /** Rewrite a pull request's title onto the house convention. Mechanical bookkeeping like {@link setWorkItemState}, so it is not auto-send gated; callers skip a write whose rendered title already matches. Throws if it fails. */
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
  /** Retarget a pull request's base — a stack rung whose parent merged. GitHub does this itself, Azure does not, which is the whole reason the seam exists. Idempotent. Throws if it fails. */
  setPullBase(input: PrBaseInput): Promise<SendResult>;
  /**
   * Merge the base branch into a pull request that is merely behind it —
   * server-side, no worktree, no agent. Only ever called for a PR the provider
   * reported as `behind`; the conflicted case keeps its agent.
   *
   * `ok: false` is "this provider cannot do it", not a failure — the caller falls
   * back to a code agent. Throws only when the provider has the operation and it failed.
   */
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
  /**
   * Queue a fresh run of a CI check the provider reports as expired. Only ever
   * called for a check carrying a `requeueRef`.
   *
   * `ok: false` is "the requeue did not happen", not a thrown failure — a provider
   * without the operation, and one that has it and declined (Azure answers 200 for
   * a policy it will not restart). Both fall back to the code agent.
   */
  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult>;
  /**
   * Delete a branch on the remote after its pull request merged. Mechanical
   * bookkeeping like {@link setPullTitle}, so it is not auto-send gated.
   *
   * A branch that is already gone is a success, not a failure — with GitHub's
   * auto-delete setting on, already-absent is the common case. Throws otherwise.
   */
  deleteBranch(input: BranchDeleteInput): Promise<SendResult>;
}
