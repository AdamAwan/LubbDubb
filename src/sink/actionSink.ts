/**
 * The outbound seam — the mirror image of {@link Connector}.
 *
 * `Connector` reads the world; `ActionSink` *changes* it. Every side-effectful
 * action the harness may take autonomously goes through this interface, so a real
 * GitHub / Azure DevOps adapter drops in here exactly the way a real read
 * connector drops in behind `Connector`, without any other module changing.
 *
 * v1 ships `FakeConnector` as the sink too: it "sends" by reflecting the effect
 * back into its own fake world (marking the answered comment handled), so nothing
 * actually leaves the machine while the seam stays real and testable.
 */

export interface PrReplyInput {
  prNumber: number;
  /** The review comment being answered, if this reply is threaded under one. */
  commentId: string | null;
  body: string;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export interface PrMergeInput {
  prNumber: number;
  /** How to land the branch. */
  method: MergeMethod;
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

export interface WorkItemStateInput {
  /** The work item / issue number to transition. */
  number: number;
  /** The provider-native state to move it to (e.g. Azure "In Review"). */
  state: string;
}

export interface IssueLabelInput {
  /** The issue / work item number to label. */
  number: number;
  /** The label (tag) to add or remove — the watch/ignore tag. */
  label: string;
  /** True to add the label, false to remove it. Idempotent either way. */
  present: boolean;
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

export interface SendResult {
  ok: boolean;
  /** A provider-side reference for the sent artifact (e.g. a comment id/URL), for the audit log. */
  ref?: string;
}

export interface ActionSink {
  /** Post a reply on a pull request. Throws if the send fails. */
  postPrReply(input: PrReplyInput): Promise<SendResult>;
  /** Merge a pull request (the last step of the issue → PR → merge loop). Throws if the merge fails. */
  mergePr(input: PrMergeInput): Promise<SendResult>;
  /** Add/remove a label on a PR — the operator's exclusion tag toggle. Throws if it fails. */
  setPrLabel(input: PrLabelInput): Promise<SendResult>;
  /** Add/remove a label on an issue / work item — the cockpit's watch/ignore toggle. Throws if it fails. */
  setIssueLabel(input: IssueLabelInput): Promise<SendResult>;
  /**
   * Move a work item to a provider-native state (e.g. Azure "In Review" once a PR
   * is open), so it stops being re-picked while under review. Idempotent. Throws if
   * it fails. Only providers with a rich state model implement it.
   */
  setWorkItemState(input: WorkItemStateInput): Promise<SendResult>;
  /**
   * Create or update a comment on an issue / work item — the plan's status comment,
   * the one progress channel both providers share. `ref` on the result is the
   * provider comment id, so the next write edits rather than re-posts. Throws if it
   * fails. Only providers with a comment API implement it.
   */
  upsertIssueComment(input: IssueCommentInput): Promise<SendResult>;
  /**
   * Open a pull request. `ref` on the result is the new PR number, so the audit log
   * records what was created. Throws if creation fails.
   *
   * The harness authoring its own PRs is what makes the title convention
   * enforceable rather than merely requested — but it never replaces an agent
   * opening one itself, which stays the floor when the tool channel is off.
   */
  createPullRequest(input: PrCreateInput): Promise<SendResult>;
  /**
   * Rewrite a pull request's title onto the house convention. Mechanical
   * bookkeeping like {@link setWorkItemState}, so it is not auto-send gated;
   * callers skip a write whose rendered title already matches. Throws if it fails.
   */
  setPullTitle(input: PrTitleInput): Promise<SendResult>;
  /**
   * Retarget a pull request's base — a stack rung whose parent merged. GitHub does
   * this itself, Azure does not, which is the whole reason the seam exists.
   * Idempotent: callers skip a write whose base is already right. Throws if it fails.
   */
  setPullBase(input: PrBaseInput): Promise<SendResult>;
}
