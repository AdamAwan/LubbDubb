import { issueOrigin } from '../../plans/planning.js';
import { toolSchema } from '../schema.js';
import {
  amendedReportReason,
  amendedSinceRunBegan,
  handbackReason,
  ReportSchema,
  validateReport,
  validationReportTarget,
} from '../../validation/report.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const validationReport: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Record what you saw when you ran the validation check you were dispatched for — the one check a person ' +
    'handed to the fleet. Say "passed" or "failed" only if you actually carried the procedure out; a green ' +
    'build, a merged pull request or code that looks correct are none of them this check, which exists ' +
    'precisely because those had already happened. If you could not run it — no login, no browser, no access ' +
    'to the environment — say "handback" and why: that records no result and gives the check back to the ' +
    'operator, and it is the right answer rather than a last resort. If the test plan asked you to hand a ' +
    'screen back, say "captured" and name the image you wrote: you state no outcome, and a person judges it.',
  inputSchema: toolSchema(ReportSchema),
  handler: (args) => {
    const target = validationReportTarget(task.originRef);
    if (!target.ok) return toolError(target.error);
    const origin = issueOrigin(target.issueNumber);
    const check = deps.store.getValidationCheck(origin, target.checkId);
    if (!check) {
      return toolError(
        `Check "${target.checkId}" is no longer part of issue #${target.issueNumber}'s validation plan — an ` +
          'amendment withdrew it while you were running it. Nothing was recorded, and nothing more is needed ' +
          'from you on it.',
      );
    }
    const parsed = validateReport(args);
    if (!parsed.ok) return toolError(`Report rejected: ${parsed.error}`);
    const { result, note, capture } = parsed.report;

    if (result !== 'handback' && amendedSinceRunBegan(check, task.createdAt)) {
      return toolError(amendedReportReason(check));
    }

    if (result === 'handback') {
      const next = deps.store.recordValidationHandback(origin, check.id, handbackReason(note, 'agent'));
      return ok({
        reported: 'handback',
        check: `${check.letter}. ${check.id}`,
        state: next?.state ?? check.state,
        means:
          'no result was recorded and the check is back with the operator, with your reason on it. Its state is ' +
          'unchanged, which is the honest answer — you did not find anything out about the goal.',
      });
    }

    // A capture asserts nothing and never goes green on its own: the row reaches *captured, waiting
    // to be looked at*, carrying the image, and becomes passed or failed only when a person records
    // a reading. A result is declared, never derived, and an image is not a declaration.
    // → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
    const next = deps.store.recordValidationResult(origin, check.id, {
      state: result,
      note,
      by: 'agent',
      ...(capture === undefined ? {} : { capture }),
    });
    if (!next) {
      return toolError(
        `Check "${check.id}" could not be written — its plan withdrew it. Nothing was recorded, and nothing more ` +
          'is needed from you on it.',
      );
    }
    if (next.state === 'captured')
      return ok({
        reported: 'captured',
        check: `${check.letter}. ${check.id}`,
        capture: next.capture,
        recordedBy: 'agent',
        means:
          'the screen is on the row and an operator is asked to look at it. You have stated no outcome and the ' +
          'check is not green — whether what you captured is right is a judgement, which is the whole reason ' +
          'the plan asked for a picture instead of an assertion.',
      });
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
