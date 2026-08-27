import { reviewTargetPr } from '../../review/prReview.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The triage's verdict: which of the project's review modes this pull request
 * gets.
 *
 * **A name from an enum, not a sentence.** The routing decision is an LLM's — a
 * threshold could not make it — but what comes back has to be data, because three
 * things downstream act on it before any agent reads a line of the diff: the
 * prompt the reviewer is given, the charter appended to it, and the model it runs
 * on. An agent that merely *said* which mode it would use in prose would leave
 * all three resolved by the harness's default, silently, and the Decision log
 * unable to say which mode ran.
 * → `docs/spec/07-pull-requests.md#choosing-how-to-review`
 */
export const reviewRoute: ToolFactory = ({ deps, agent, task, ok }) => {
  // The project's own modes, in declaration order. Built per caller for the
  // reason `appraise_issue` builds its profile list per caller: the deployment's
  // vocabulary is config, and a tool that offered a name this project has not
  // declared would be inviting a route nothing can honour.
  const modes = deps.reviewModes ?? [];
  return {
    description:
      'Choose how thoroughly the PULL REQUEST you were dispatched for should be reviewed. You are not ' +
      'reviewing it — you are deciding what kind of read it needs, and an agent is dispatched on your ' +
      'answer. Judge the change against what this project says below about choosing; where it does not ' +
      'settle the question, prefer the more thorough mode, because the cost of over-reading a small ' +
      'change is minutes and the cost of under-reading a dangerous one is the defect nobody caught. ' +
      (modes.length > 0 ? `This project's modes are: ${modes.join(', ')}.` : ''),
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          ...(modes.length > 0 ? { enum: [...modes] } : {}),
          description: 'The mode this pull request should be reviewed in. One of the names listed above.',
        },
        reason: {
          type: 'string',
          description:
            'Why, in one or two sentences and about *this* change — what you saw that made it need this ' +
            'depth. It is the whole of what an operator reads later when a review turns out to have been ' +
            'the wrong shape, so "it is small" is not a reason.',
        },
      },
      required: ['mode', 'reason'],
    },
    handler: (args) => {
      const prNumber = reviewTargetPr(task.originRef, 'review-triage');
      if (prNumber === null) {
        return toolError(
          'review_route is for an agent dispatched to triage a pull request, and this run was dispatched ' +
            `for ${task.originRef ?? 'no origin'}. Nothing was recorded.`,
        );
      }
      const input = args as { mode?: unknown; reason?: unknown };
      const mode = typeof input.mode === 'string' ? input.mode.trim() : '';
      // Checked here as well as in the schema: a mode the project has not
      // declared has no charter and no profile behind it, so honouring it would
      // be a review that reads as routed and ran on the default.
      if (!modes.includes(mode)) {
        return toolError(
          `Route rejected: "${mode}" is not one of this project's review modes (${modes.join(', ') || 'none declared'}).`,
        );
      }
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      if (reason === '') return toolError('Route rejected: the reason is what an operator reads instead of guessing.');

      const route = deps.store.recordPrReviewRoute({ prNumber, mode, reason, agentId: agent.id });
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
