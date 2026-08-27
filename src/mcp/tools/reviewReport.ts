import { reviewTargetPr } from '../../review/prReview.js';
import { toolError } from '../protocol.js';
import type { PrReviewVerdict } from '../../types.js';
import type { ToolFactory } from './context.js';

/**
 * The reviewer's verdict, and the whole of what the harness keeps about a fleet
 * review.
 *
 * **The record is this call, never a comment on the provider.** A project may
 * tell its reviewer to publish what it found (`review.publish`), and where it
 * does the comment goes out through `reply_to_review` like any other outbound
 * act — but the merge gate reads *this* row. A gate that read the provider
 * instead would be satisfied by anything that could write a comment, the
 * reviewer's own prose included.
 * → `docs/spec/07-pull-requests.md#the-fleet-review`
 */
export const reviewReport: ToolFactory = ({ deps, agent, task, ok }) => ({
  description:
    'Record what you found reviewing the PULL REQUEST you were dispatched for. This is the review — the ' +
    'harness keeps what you say here, and a person reads it before they approve the merge. Say "clear" ' +
    "if you found nothing a reviewer would want to raise; the bar is *worth a colleague's attention*, " +
    'not *perfect*. Say "findings" and list them if you did. You are reading, not fixing: do not commit, ' +
    'do not push, and do not open anything. You are reviewed once, so a finding you leave out is a ' +
    'finding nobody hears — and a list of nits padded around one real defect is how the real one gets ' +
    'skimmed past.',
  inputSchema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['clear', 'findings'],
        description:
          'clear: nothing here needs raising before this merges. findings: something does, and it is listed.',
      },
      summary: {
        type: 'string',
        description:
          'One sentence saying what this change does, as you understood it from the diff. It is what makes ' +
          'a wrong reading visible: a summary that does not match the ticket is itself the finding.',
      },
      findings: {
        type: 'array',
        items: { type: 'string' },
        description:
          'What you found, one entry each, most serious first. Each says where it is and what breaks — a ' +
          'file and a concrete failure, not "consider refactoring". Omit on a "clear" verdict.',
      },
    },
    required: ['verdict', 'summary'],
  },
  handler: (args) => {
    const prNumber = reviewTargetPr(task.originRef);
    if (prNumber === null) {
      return toolError(
        'review_report is for an agent dispatched to review a pull request, and this run was dispatched for ' +
          `${task.originRef ?? 'no origin'}. Nothing was recorded.`,
      );
    }
    const input = args as { verdict?: unknown; summary?: unknown; findings?: unknown };
    const verdict: PrReviewVerdict | null =
      input.verdict === 'clear' ? 'clear' : input.verdict === 'findings' ? 'findings' : null;
    if (verdict === null) return toolError('Review rejected: verdict must be "clear" or "findings".');
    const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
    if (summary === '') return toolError('Review rejected: summary is what a person reads instead of the diff.');
    const findings = Array.isArray(input.findings)
      ? input.findings.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [];
    // A `findings` verdict with nothing under it is the one shape that reads as
    // the opposite of itself downstream: the row says something was found and
    // every surface that quotes it has nothing to quote.
    if (verdict === 'findings' && findings.length === 0) {
      return toolError('Review rejected: a "findings" verdict has to list at least one finding.');
    }
    // What was actually in front of the reviewer, taken from the harness's own
    // last reading rather than asked of the agent — a SHA an agent types is a
    // SHA that can be wrong. Null where the provider reports none, which decides
    // nothing either way (see `needsFleetReview`).
    const headSha = deps.store.getWorldBaseline()?.pullRequests.find((pr) => pr.number === prNumber)?.headSha ?? null;
    const review = deps.store.recordPrReview({
      prNumber,
      headSha,
      verdict,
      summary,
      findings,
      agentId: agent.id,
    });
    return ok({
      recorded: review.verdict,
      pullRequest: prNumber,
      findings: findings.length,
      means:
        verdict === 'clear'
          ? 'the pull request is no longer held out of the merge gate for want of a review. It still needs ' +
            'its human approval — your verdict informs that decision, it does not stand in for it.'
          : "your findings are on the pull request's row for whoever approves the merge, and the merge gate " +
            'no longer holds it for want of a review. Nothing re-reviews this pull request, so what you have ' +
            "written is the whole of the fleet's reading of it.",
    });
  },
});
