import { issueSubtreeNumber } from '../../issueOrigins.js';
import { issueOrigin } from '../../plans/planning.js';
import { proposePlanAmendment } from '../../plans/planAmendment.js';
import { currentPlanSummary } from '../../plans/parts.js';
import { z } from 'zod';
import { PLAN_DOCUMENT_SHAPE } from '../planDocumentSchema.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const planCorrect: ToolFactory = ({ deps, task, ok }) => ({
  description:
    'Propose a correction to the delivery plan for the goal you are working on, when what you have found in ' +
    'the repository does not match what the plan assumed: a part that is really two, a dependency that runs ' +
    'the other way, a step the code already does, scope that belongs somewhere else. Submit the **whole** ' +
    'document, not a patch — every part you are keeping included under its existing slug, since the slug is ' +
    'what an amendment merges on and a part you omit is one you are asking to drop. It changes nothing by ' +
    'itself: an operator is asked, the plan keeps running while they decide, and your own work is not paused, ' +
    'stopped or re-dispatched either way. Use it for the plan being wrong, never for your part being hard — ' +
    'a part you cannot finish is an escalation, and one that turns out not to need building is ' +
    'conclude_part with a determination. Validated immediately: on rejection you get the reason back and can ' +
    'fix and resubmit in this same turn.',
  inputSchema: toolSchema(
    z.object({
      note: z
        .string()
        .describe(
          'Why the plan must change, in a few sentences. This is the whole of what the operator reads beside ' +
            'the diff, so say what you found and where — a correction with no reason on it is one they cannot ' +
            'answer.',
        ),
      ...PLAN_DOCUMENT_SHAPE,
    }),
  ),
  handler: (args) => {
    const issue = issueSubtreeNumber(task.originRef);
    if (issue === null) {
      return toolError(
        `plan_correct is only available to an agent working a planned goal. This task's origin is ` +
          `${task.originRef ?? '(none)'}, which names no issue.`,
      );
    }
    const originRef = issueOrigin(issue);
    const plan = deps.store.getPlanByOrigin(originRef);
    if (!plan) {
      return toolError(
        `Issue #${issue} has no plan, so there is nothing to correct. Say what you found in your conclusion ` +
          'instead.',
      );
    }
    const proposed = proposePlanAmendment(deps.store, {
      plan,
      document: {
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
      },
      note: typeof args.note === 'string' ? args.note : '',
      author: 'agent',
      authorRef: task.id,
    });
    if (!proposed.ok) return toolError(proposed.error);

    const parts = deps.store.listPlanParts(plan.id);
    return ok({
      proposed: true,
      amendmentId: proposed.proposed.amendment.id,
      changes: proposed.proposed.diff?.parts.filter((p) => p.kind !== 'unchanged').map((p) => `${p.kind} ${p.slug}`),
      ...(proposed.proposed.warnings.length > 0 ? { warnings: proposed.proposed.warnings } : {}),
      currentPlan: currentPlanSummary(plan, parts, deps.openPr?.prRefStyle ?? '#'),
      means:
        'the correction is recorded and an operator has been asked about it. The plan has not changed: your ' +
        'part is still the part you were dispatched for, and the acceptance criteria you are judged on are ' +
        'still the ones you were given.',
      next:
        'Carry on with your own part under the plan as it stands. Do not wait for an answer, do not widen your ' +
        'scope to the amendment you just proposed, and do not propose a second one — if you learn more, say it ' +
        'in your conclusion, where whoever answers this will read it.',
    });
  },
});
