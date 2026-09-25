// → docs/spec/11-mcp-tools.md#reply_to_review

/** What the agent answering a review thread says about it, beside the reply itself. */
export interface ReviewThreadLabelSubmission {
  prNumber: number;
  threadId: string;
  aboutComment: boolean;
  changedCode: boolean;
  resolved: boolean;
}
