import { validatePlanDocument } from '../../plans/planDocument.js';
import { ingestPlanDocument } from '../../plans/planIngest.js';
import { issueOrigin, planOriginIssue } from '../../plans/planning.js';
import type { Task } from '../../types.js';
import { z } from 'zod';
import { PLAN_DOCUMENT_SHAPE } from '../planDocumentSchema.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

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
  inputSchema: toolSchema(z.object(PLAN_DOCUMENT_SHAPE)),
  handler: async (args) => {
    const planner = plannerIssue(task);
    if (!planner.ok) return toolError(planner.error);
    const parsed = validatePlanDocument(
      {
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
        validation: args.validation,
        watch: args.watch,
        state: args.state,
      },
      deps.store.remoteValidation.listOfferedAreas(),
    );
    if (!parsed.ok) {
      return toolError(`Plan rejected: ${parsed.error}`);
    }
    const result = ingestPlanDocument(deps.store, {
      doc: parsed.document,
      originRef: issueOrigin(planner.number),
      title: task.originTitle ?? task.title,
    });
    const refusals = (await deps.watch?.run(issueOrigin(planner.number))) ?? [];
    const stateRefusals = (await deps.state?.dryRun(issueOrigin(planner.number))) ?? [];
    return ok({
      accepted: true,
      status: result.status,
      retired: result.retired,
      awaitingApproval: 'The plan is recorded, but nothing is scheduled until an operator approves it.',
      ...(refusals.length > 0
        ? {
            watchDryRun: refusals,
            watchDryRunNote:
              'Each of these queries was run once against the environment it would watch and did not come back ' +
              'with a reading anybody could act on. Fix the query — or say why the ticket is wrong — and submit ' +
              'again. A query that resolves nothing forever is the failure this whole surface exists to catch.',
          }
        : {}),
      ...(stateRefusals.length > 0
        ? {
            stateDryRun: stateRefusals,
            stateDryRunNote:
              'Each of these was put once to the store it would ask and did not come back with a reading ' +
              'anybody could act on. Fix the query — or drop it and leave it to whoever does the work, who ' +
              'will know the shape you could not.',
          }
        : {}),
    });
  },
});
