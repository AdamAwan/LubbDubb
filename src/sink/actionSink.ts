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

export interface SendResult {
  ok: boolean;
  /** A provider-side reference for the sent artifact (e.g. a comment id/URL), for the audit log. */
  ref?: string;
}

export interface ActionSink {
  /** Post a reply on a pull request. Throws if the send fails. */
  postPrReply(input: PrReplyInput): Promise<SendResult>;
}
