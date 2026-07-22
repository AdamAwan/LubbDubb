/**
 * The outbound seam — the mirror image of {@link Connector}.
 *
 * `Connector` reads the world; `ActionSink` *changes* it. Every side-effectful
 * action the harness may take autonomously goes through this interface, so a real
 * GitHub / Azure DevOps adapter drops in here exactly the way a real read
 * connector drops in behind `Connector`, without any other module changing.
 *
 * v1 ships `FakeConnector` as the sink too: it "sends" by reflecting the effect
 * back into its own fake world (marking the answered comment handled) and logging
 * a connector event, so nothing actually leaves the machine while the seam stays
 * real and testable.
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
}
