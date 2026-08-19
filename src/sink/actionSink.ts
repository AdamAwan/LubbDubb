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

export interface IssueLabelInput {
  /** The issue / work item number to label. */
  number: number;
  /** The label (tag) to add or remove — the watch/ignore tag. */
  label: string;
  /** True to add the label, false to remove it. Idempotent either way. */
  present: boolean;
}

/**
 * A tracker item the harness is creating — the outbound half of a filing.
 *
 * Everything a create needs is here, and that is the point: the four filing arms
 * used to spell this out as a `gh`/`az` command string for a model to run, so a
 * label, a type or a relation the harness knew about was only ever as reliable as
 * the model's memory of the sentence naming it (issue #394).
 *
 * `type` and `relatedTo` are **provider-native, not provider-specific**: each
 * adapter expresses them in its own vocabulary or ignores them. GitHub has no work
 * item type and drops it; it draws a relation as a `#<n>` cross-reference in the
 * body, which is the only edge it has. Azure DevOps creates *as* a type and hangs a
 * `related` link off the new item. A caller states the intent once and never learns
 * which tracker it landed in.
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
 * Where a filing would land and who it would be filed by — the answer to "can I
 * file, and where, and as whom", asked live rather than read off config
 * (issue #413).
 *
 * Config already says which tracker is *selected*; what it cannot say is whether
 * the credential behind it still works, and that is the half worth asking before
 * an operator types a report into a box. So this is resolved by a real provider
 * call and **throws** when the provider will not answer — a dead token is the
 * outcome this exists to catch, not an inconvenience to hide.
 *
 * `identity` is null for a provider with no notion of who is authenticated (the
 * fake), never an invented name: "filing as nobody in particular" is a true thing
 * to show an operator and a made-up login is not.
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
   * Create a tracker item — the harness filing its own, rather than composing a
   * `gh`/`az` command for an agent to run (issue #394).
   *
   * `ref` on the result is the new item in the harness's own vocabulary
   * (`issue:314`), not a provider id: that is what a filing row stores, what
   * `link_ticket` accepts and what the cockpit resolves to a URL, so the one
   * translation happens here rather than at each of the four call sites.
   *
   * Throws when the provider has the operation and it failed. Unlike
   * {@link updatePrBranch} there is no `ok: false` arm — a caller only reaches this
   * once a tracker is configured, and a configured tracker that cannot create an
   * item is a fault, not a shape.
   */
  createIssue(input: IssueCreateInput): Promise<SendResult>;
  /**
   * Link a work item to the pull request that resolves it — the tracker-side
   * relation, not a mention in prose.
   *
   * **`ok: false` is "this provider does not need it", not a failure**, the way
   * {@link updatePrBranch}'s is. GitHub links an issue to a pull request from the
   * body's `#12` itself, so nothing there implements this and there is nothing to
   * fix; Azure DevOps links only through a work-item artifact link, which is what
   * its **Check for linked work items** branch policy reads. Throws only when the
   * provider *has* the operation and it failed.
   *
   * Idempotent: linking a pull request a work item already carries is a success.
   */
  linkWorkItem(input: WorkItemLinkInput): Promise<SendResult>;
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
  /**
   * Merge the base branch into a pull request that is merely **behind** it —
   * server-side, with no worktree and no agent (issue #332). Only ever called for
   * a PR the provider itself reported as `behind`, i.e. one it has already said
   * merges cleanly; the conflicted case is judgement and keeps its agent.
   *
   * **`ok: false` is "this provider cannot do it", not a failure.** GitHub has
   * `PUT /pulls/{n}/update-branch`; Azure DevOps has no equivalent, and that is a
   * legitimate configuration rather than a wiring fault — so the composite answers
   * `ok: false` instead of throwing, and the caller falls back to the code agent
   * that did this work before. Throws only when the provider *has* the operation
   * and it failed, which is the case worth an error entry.
   */
  updatePrBranch(input: PrBaseUpdateInput): Promise<SendResult>;
  /**
   * Queue a fresh run of a CI check the provider reports as **expired** — the
   * gate whose cause the harness already knows, cleared without an agent
   * (issue #395). Only ever called for a check carrying a `requeueRef`, which is
   * only ever set on an expired one.
   *
   * **`ok: false` is "the requeue did not happen", not a thrown failure**, and it
   * covers one case more than {@link updatePrBranch}'s does. A provider with no
   * such operation answers it from the composite, as there; and so does a
   * provider that *has* it and declined — Azure answers 200 for a policy it will
   * not restart, so the only honest reading of "still expired" is that nothing
   * was queued. Both fall back to the code agent rule `pr-ci-gate` dispatched
   * before this existed. Throws only when the call itself failed.
   */
  requeueCiCheck(input: CiCheckRequeueInput): Promise<SendResult>;
  /**
   * Delete a branch on the remote — the branch behind a pull request that has
   * merged. Mechanical bookkeeping like {@link setPullTitle}, so it is not auto-send
   * gated.
   *
   * **A branch that is already gone is a success, not a failure.** A repository with
   * GitHub's "automatically delete head branches" setting on will have deleted it at
   * merge time, so already-absent is the common case rather than an error — and
   * throwing on it would put a permanent stream of noise in the error log on exactly
   * the repositories configured best. Throws for anything else.
   */
  deleteBranch(input: BranchDeleteInput): Promise<SendResult>;
}
