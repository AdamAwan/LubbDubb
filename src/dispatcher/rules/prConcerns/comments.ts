import type { PullRequest } from '../../../types.js';
import {
  prCommentSignalRef,
  prCommentsOrigin,
  reviewRecheckNote,
  reviewThreadNote,
  reviewThreadsNote,
  replyToolNote,
} from '../../reviewThreads.js';
import { priorReviewRemediesNote } from '../../../remedies/priorRemedies.js';
import { remedyAskNote } from '../../../remedies/remedies.js';
import type { StageContext } from '../context.js';
import type { PrConcern } from './concern.js';

// → docs/spec/05-dispatcher.md (the PR concern pass)

export function reviewCommentConcern(pr: PullRequest, s: StageContext): PrConcern | null {
  const unhandled = pr.unresolvedComments.filter((c) => !c.handled);
  if (unhandled.length === 0) return null;
  const authors = [...new Set(unhandled.map((c) => c.author))];
  const many = unhandled.length > 1;
  return {
    rule: 'pr-review-comment',
    origin: prCommentsOrigin(pr.number),
    title: many
      ? `Address ${unhandled.length} review comments on PR #${pr.number}`
      : `Address review comment on PR #${pr.number}`,
    prompt:
      s.templates.render('pr-review-comment', {
        number: pr.number,
        branch: pr.branch,
        author: authors.join(', '),
        comment: unhandled[0]!.body,
      }) +
      reviewThreadsNote(unhandled) +
      reviewRecheckNote(pr.number) +
      replyToolNote() +
      priorReviewRemediesNote(s.ctx.priorRemedies ?? []) +
      remedyAskNote('review'),
    dispatchReason: many
      ? `${unhandled.length} unhandled review comments from ${authors.join(', ')} on PR #${pr.number}.`
      : `Unhandled review comment from ${authors[0]} on PR #${pr.number}.`,
    note: `Unhandled review feedback on PR #${pr.number} from ${authors.join(', ')}.`,
    originTitle: pr.title,
    originSummary: many
      ? `${unhandled.length} review threads on PR #${pr.number} from ${authors.join(', ')}`
      : `Review comment from ${authors[0]}: ${unhandled[0]!.body}`,
    signals: unhandled.map((c) => ({
      ref: prCommentSignalRef(pr.number, c),
      note: reviewThreadNote(pr.number, c),
    })),
  };
}
