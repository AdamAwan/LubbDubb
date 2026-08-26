import { validatePlanDocument } from '../../plans/planDocument.js';
import { ingestPlanDocument } from '../../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../../plans/planning.js';
import type { Task } from '../../types.js';
import { PLAN_DOCUMENT_SCHEMA } from '../planDocumentSchema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * The tool's origin fence, declared rather than buried: only an agent dispatched
 * to *plan* an issue may submit a decomposition for it.
 *
 * This is the one fence the tool layer owns. The others — `conclusionOrigin`,
 * `partConclusionOrigin`, `padOriginFor`, `retroSubmitOrigin`, `assessmentOrigin`,
 * `appraiserOrigin` — are asked at the fleet seam because each *resolves* something
 * out of the store as it refuses (the part, the pad, the issue), so a copy here
 * would be a second answer to a question already answered next to the write it
 * guards. This one resolves nothing but the issue number, which is pure.
 */
function plannerIssue(task: Task): { ok: true; number: number } | { ok: false; error: string } {
  const number = planOriginIssue(task.originRef);
  if (number === null) {
    return {
      ok: false,
      error:
        `plan_submit is only available to a planning agent. This task's origin is ` +
        `${task.originRef ?? '(none)'}, which is not a planning origin.`,
    };
  }
  return { ok: true, number };
}

export const planSubmit: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Submit the delivery plan for the issue you were dispatched to plan, as an ordered list of ' +
    'independently reviewable parts. Work that is one pull request is one part — there is no separate ' +
    'shape for it. Validated immediately: on rejection you get the reason back and can fix and resubmit ' +
    'in this same turn. Replaces writing .lubbdubb/plan.json.',
  inputSchema: PLAN_DOCUMENT_SCHEMA,
  handler: (args) => {
    const planner = plannerIssue(task);
    if (!planner.ok) return toolError(planner.error);
    // Same schema as the file path, so the two transports accept and reject
    // exactly the same documents — the difference is only that this one can
    // hand the reason back instead of burning an attempt to discover it.
    const parsed = validatePlanDocument({
      version: 1,
      reason: args.reason,
      diagnosis: args.diagnosis,
      approach: args.approach,
      risks: args.risks,
      outOfScope: args.outOfScope,
      alternatives: args.alternatives,
      openQuestions: args.openQuestions,
      verification: args.verification,
      evidence: args.evidence ?? [],
      document: args.document,
      parts: args.parts ?? [],
      // Passed through rather than defaulted to an empty block: `ValidationSchema`
      // is optional precisely so that *absent* means "leave the existing checks
      // alone", and `{checks: []}` would read to `ingestPlanDocument` as a planner
      // withdrawing every check somebody is halfway through running.
      validation: args.validation,
    });
    if (!parsed.ok) {
      // Nothing is written on a rejection: the caller retries against an
      // unchanged plan graph rather than a half-applied one.
      return toolError(`Plan rejected: ${parsed.error}`);
    }
    const result = ingestPlanDocument(deps.store, {
      doc: parsed.document,
      originRef: issueOrigin(planner.number),
      title: task.originTitle ?? task.title,
    });
    // Said out loud rather than left to be read off the status string: a
    // planner that thinks its parts are being worked would otherwise sit
    // waiting for siblings that will not start until a human clicks accept.
    return ok({
      accepted: true,
      status: result.status,
      retired: result.retired,
      awaitingApproval: 'The plan is recorded, but nothing is scheduled until an operator approves it.',
    });
  },
});
