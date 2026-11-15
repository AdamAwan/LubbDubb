export type PrReviewVerdict = 'clear' | 'findings';

export interface PrReview {
  prNumber: number;
  headSha: string | null;
  verdict: PrReviewVerdict;
  summary: string;
  findings: string[];
  agentId: string | null;
  reviewedAt: string;
  publishedThread: string | null;
}

export interface PrReviewRoute {
  prNumber: number;
  mode: string;
  skipped: boolean;
  reason: string;
  agentId: string | null;
  decidedAt: string;
}

export type PrReviewRouteInput = Omit<PrReviewRoute, 'decidedAt'>;

export type PrSplitVerdictKind = 'split' | 'coherent';

export interface PrSplitVerdict {
  prNumber: number;
  issueNumber: number;
  verdict: PrSplitVerdictKind;
  concepts: string[];
  reason: string;
  files: number;
  agentId: string | null;
  decidedAt: string;
}

export type PrSplitVerdictInput = Omit<PrSplitVerdict, 'decidedAt'>;

export type PrReviewInput = Omit<PrReview, 'reviewedAt' | 'publishedThread'>;

export interface PrReplySent {
  prNumber: number;
  threadId: string;
  commentRef: string;
  sentAt: string;
}

/** What an agent said about one review thread as it answered it. One row per thread, last answer wins. */
export interface PrThreadLabelInput {
  prNumber: number;
  threadId: string;
  aboutComment: boolean;
  changedCode: boolean;
  resolved: boolean;
  path: string | null;
  author: string | null;
  /** What the provider said at the time; null where it said nothing. Never a re-derivation. */
  authorIsBot: boolean | null;
  agentId: string;
  taskId: string;
}

export interface PrThreadLabel extends PrThreadLabelInput {
  answeredAt: string;
}

/**
 * The four things a reviewer has to be able to answer, as the questions the
 * description field puts under itself. They are the same four
 * [07](../docs/spec/07-pull-requests.md) already takes off the agent and turns into
 * coordinates — asked here of the operator, in prose, about the same change.
 *
 * Hints rather than fields: nothing requires an answer to any of them. What they buy
 * is that an operator who cannot answer one notices before a reviewer does.
 */
export type DescriptionQuestion = 'asked-for' | 'undone' | 'missing' | 'reach';

/**
 * What one finding of a description check says.
 *
 * `contradicted` is the description asserting something the diff does not do, and it
 * is the one worth reading on its own: it means the pull request would have carried
 * a false sentence under a person's name into somebody's review. `gap` is something
 * the diff raises that the description does not — a reviewer left to find it out for
 * themselves, which is worse than nothing said but not the same defect.
 */
export type DescriptionFindingKind = 'contradicted' | 'gap';

/**
 * One thing a check found.
 *
 * `question` is an **optional tag**, not the schema. The four questions are hints
 * under the field and it is worth recording when the diff raises one the description
 * cannot answer — but a check keyed *by* them can only report on four things, and
 * most of what is worth saying about a description against its diff is none of them.
 * So a finding stands on its own and names a question only where it happens to be
 * one. → docs/spec/07-pull-requests.md#it-contradicts-it-never-drafts
 */
export interface DescriptionFinding {
  kind: DescriptionFindingKind;
  note: string;
  question: DescriptionQuestion | null;
}

export type DescriptionChannel = 'cockpit' | 'claude-code';

export interface PrDescriptionVersion {
  id: string;
  originRef: string;
  version: number;
  supersedes: string | null;
  text: string;
  author: string | null;
  authoredAt: string;
  /** Where the operator's words were entered. → docs/spec/07-pull-requests.md#relayed-through-claude-code */
  via: DescriptionChannel;
  checkedAt: string | null;
  findings: DescriptionFinding[];
  /** The operator pressed to leave this check's findings as they are. A re-check clears it. */
  dismissedAt: string | null;
}

/**
 * The operator's newest description of a part whose pull request is open, not yet read
 * against its diff. What rule `pr-description-check` dispatches for.
 * → docs/spec/07-pull-requests.md#every-description-is-checked-without-asking
 */
export interface DescriptionAwaitingCheck {
  versionId: string;
  originRef: string;
  prNumber: number;
  text: string;
  authoredAt: string;
}

/**
 * The body the agent wrote for a part's pull request, kept rather than shipped.
 * `text` is null only where the agent sent none and the
 * operator handed it over anyway; `handedAt` is the operator's press; `pushedAt` is
 * when it reached the pull request. → docs/spec/07-pull-requests.md#the-agents-draft
 */
export interface PrDescriptionDraft {
  originRef: string;
  prNumber: number;
  text: string | null;
  writtenAt: string | null;
  handedBy: string | null;
  handedAt: string | null;
  pushedAt: string | null;
}
