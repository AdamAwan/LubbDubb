import { reviewTargetPr } from '../../review/prReview.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const reviewRoute: ToolFactory = ({ deps, agent, task, ok }) => {
  const modes = deps.reviewModes ?? [];
  const allowSkip = deps.reviewAllowSkip === true;
  return {
    description:
      'Choose how thoroughly the PULL REQUEST you were dispatched for should be reviewed. You are not ' +
      'reviewing it — you are deciding what kind of read it needs, and an agent is dispatched on your ' +
      'answer. Judge the change against what this project says below about choosing; where it does not ' +
      'settle the question, prefer the more thorough mode, because the cost of over-reading a small ' +
      'change is minutes and the cost of under-reading a dangerous one is the defect nobody caught. ' +
      (modes.length > 0 ? `This project's modes are: ${modes.join(', ')}.` : '') +
      (allowSkip
        ? ' This project also lets you decide a pull request needs no review at all — pass `skip: true` ' +
          'instead of a mode, and only where reading the diff could not change anything.'
        : ''),
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          ...(modes.length > 0 ? { enum: [...modes] } : {}),
          description: allowSkip
            ? 'The mode this pull request should be reviewed in. One of the names listed above. Omit it ' +
              'only when you are passing `skip: true`.'
            : 'The mode this pull request should be reviewed in. One of the names listed above.',
        },
        ...(allowSkip
          ? {
              skip: {
                type: 'boolean',
                description:
                  'True if this pull request needs no review at all — a version bump, a regenerated ' +
                  'lockfile, a typo in a comment. It also releases the merge gate, so anything that ' +
                  'changes behaviour gets a mode however small the diff. Give a mode or this, not both.',
              },
            }
          : {}),
        reason: {
          type: 'string',
          description:
            'Why, in one or two sentences and about *this* change — what you saw that made it need this ' +
            'depth. It is the whole of what an operator reads later when a review turns out to have been ' +
            'the wrong shape, so "it is small" is not a reason.',
        },
      },
      required: allowSkip ? ['reason'] : ['mode', 'reason'],
    },
    handler: (args) => {
      const prNumber = reviewTargetPr(task.originRef, 'review-triage');
      if (prNumber === null) {
        return toolError(
          'review_route is for an agent dispatched to triage a pull request, and this run was dispatched ' +
            `for ${task.originRef ?? 'no origin'}. Nothing was recorded.`,
        );
      }
      const input = args as { mode?: unknown; reason?: unknown; skip?: unknown };
      const mode = typeof input.mode === 'string' ? input.mode.trim() : '';
      const skip = input.skip === true;
      if (skip && !allowSkip) {
        return toolError(
          'Route rejected: this project does not allow skipping a review (review.allowSkip is off). ' +
            `Name one of its modes instead (${modes.join(', ') || 'none declared'}).`,
        );
      }
      if (skip && mode !== '') {
        return toolError(`Route rejected: you asked to skip the review *and* named "${mode}". Give one or the other.`);
      }
      if (!skip && !modes.includes(mode)) {
        return toolError(
          `Route rejected: "${mode}" is not one of this project's review modes (${modes.join(', ') || 'none declared'}).`,
        );
      }
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason === '') return toolError('Route rejected: the reason is what an operator reads instead of guessing.');

      const route = deps.store.recordPrReviewRoute({
        prNumber,
        mode: skip ? '' : mode,
        skipped: skip,
        reason,
        agentId: agent.id,
      });
      if (route.skipped) {
        return ok({
          skipped: true,
          pullRequest: prNumber,
          means:
            'this pull request is not reviewed by the fleet, and the merge gate no longer holds it. Your ' +
            'reason is the whole record of why. Nothing else is needed from you — do not review the change ' +
            'yourself.',
        });
      }
      return ok({
        routed: route.mode,
        pullRequest: prNumber,
        means:
          `the review of this pull request is dispatched in "${route.mode}" mode on the next pulse, with that ` +
          "mode's charter and profile. Nothing else is needed from you — do not review the change yourself.",
      });
    },
  };
};
