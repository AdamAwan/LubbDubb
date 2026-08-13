import { issueOrigin } from '../../plans/planning.js';
import { handbackReason, validateReport, validationReportTarget } from '../../validation/report.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const validationReport: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Record what you saw when you ran the validation check you were dispatched for — the one check a person ' +
    'handed to the fleet. Say "passed" or "failed" only if you actually carried the procedure out; a green ' +
    'build, a merged pull request or code that looks correct are none of them this check, which exists ' +
    'precisely because those had already happened. If you could not run it — no login, no browser, no access ' +
    'to the environment — say "handback" and why: that records no result and gives the check back to the ' +
    'operator, and it is the right answer rather than a last resort.',
  inputSchema: {
    type: 'object',
    properties: {
      result: {
        type: 'string',
        enum: ['passed', 'failed', 'handback'],
        description:
          '"passed" — you followed the procedure and saw what it expects. "failed" — you followed it and did ' +
          'not; a real finding about the goal. "handback" — you could not run it, so nothing is recorded and ' +
          'a person gets it back.',
      },
      note: {
        type: 'string',
        description:
          'What you actually saw, or what stopped you. This is the whole of what an operator reads later ' +
          'instead of running the check again, so "passed" is not a note.',
      },
    },
    required: ['result', 'note'],
  },
  handler: (args) => {
    if (!deps.validationEnabled) {
      return toolError(
        'Validation plans are off in this deployment, so there is no check to report on. Say what you found in ' +
          'your progress note instead.',
      );
    }
    const target = validationReportTarget(task.originRef);
    if (!target.ok) return toolError(target.error);
    const plan = deps.store.getPlanByOrigin(issueOrigin(target.issueNumber));
    // Both of these are "the world moved under a dispatch that is still running":
    // a plan deleted, or an amendment that withdrew the check between the agent
    // being sent and it reporting. Said plainly rather than as a refusal, because
    // neither is the agent's fault and neither is something it can fix.
    if (!plan) {
      return toolError(`Issue #${target.issueNumber} no longer has a plan, so this check has nowhere to be recorded.`);
    }
    const check = deps.store.getValidationCheck(plan.id, target.checkId);
    if (!check) {
      return toolError(
        `Check "${target.checkId}" is no longer part of issue #${target.issueNumber}'s validation plan — an ` +
          'amendment withdrew it while you were running it. Nothing was recorded, and nothing more is needed ' +
          'from you on it.',
      );
    }
    const parsed = validateReport(args);
    if (!parsed.ok) return toolError(`Report rejected: ${parsed.error}`);
    const { result, note } = parsed.report;

    if (result === 'handback') {
      const next = deps.store.recordValidationHandback(plan.id, check.id, handbackReason(note));
      return ok({
        reported: 'handback',
        check: `${check.letter}. ${check.id}`,
        // Stated rather than left to be inferred from the absence of a state: an
        // agent told only "ok" would reasonably believe it had settled the check.
        state: next?.state ?? check.state,
        means:
          'no result was recorded and the check is back with the operator, with your reason on it. Its state is ' +
          'unchanged, which is the honest answer — you did not find anything out about the goal.',
      });
    }

    const next = deps.store.recordValidationResult(plan.id, check.id, {
      state: result,
      note,
      // Attributed to the fleet, not to a person, and drawn everywhere the
      // reading is: "an agent says this passed" and "I ran it and it passed" are
      // different facts, and the second must never be assumed from the first.
      by: 'agent',
    });
    if (!next) {
      return toolError(
        `Check "${check.id}" could not be written — its plan withdrew it. Nothing was recorded, and nothing more ` +
          'is needed from you on it.',
      );
    }
    return ok({
      reported: next.state,
      check: `${check.letter}. ${check.id}`,
      recordedBy: 'agent',
      means:
        "the operator sees this reading marked as an agent's. If you did not actually carry the procedure out, " +
        'say so now with a progress note — a pass nobody ran is the one outcome this check exists to prevent.',
    });
  },
});
