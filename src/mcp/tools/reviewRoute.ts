import { reviewTargetPr } from '../../review/prReview.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The triage's verdict: which of the project's review modes this pull request
 * gets.
 *
 * Where the project set `review.allowSkip`, it is also where the triage says a
 * pull request needs **no** review — `skip: true` instead of a mode. The argument
 * is offered only on those deployments: a tool whose schema always carried it
 * would put the option in front of every triage on every project, and the one
 * answer that waives the gate is not one to leave lying around.
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
  // Absent reads as off, which is the safe absence: a deployment whose wiring
  // never reached this gets the tool it had before skipping existed, rather than
  // a triage that can waive a gate the project never opened.
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
        // Offered only where the project allowed it, so a triage elsewhere cannot
        // reach for an answer its project never put on the table.
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
      // `mode` stays required where nothing else can be answered instead; with a
      // skip on offer the reason is the only thing every answer carries.
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
      // Checked here as well as in the schema, for the reason the mode is: a skip
      // on a project that did not allow one is an answer with no policy behind it,
      // and honouring it would waive a gate nobody opened.
      const skip = input.skip === true;
      if (skip && !allowSkip) {
        return toolError(
          'Route rejected: this project does not allow skipping a review (review.allowSkip is off). ' +
            `Name one of its modes instead (${modes.join(', ') || 'none declared'}).`,
        );
      }
      // Both is not an answer: one of them would be ignored, and nothing on the row
      // would say which.
      if (skip && mode !== '') {
        return toolError(`Route rejected: you asked to skip the review *and* named "${mode}". Give one or the other.`);
      }
      // Checked here as well as in the schema: a mode the project has not
      // declared has no charter and no profile behind it, so honouring it would
      // be a review that reads as routed and ran on the default.
      if (!skip && !modes.includes(mode)) {
        return toolError(
          `Route rejected: "${mode}" is not one of this project's review modes (${modes.join(', ') || 'none declared'}).`,
        );
      }
      const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
      // Required on a skip most of all: the row is the only account of why a change
      // went in unread, and the only thing an operator has to go on later.
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
