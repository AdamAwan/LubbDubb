import { originIssueNumber, issueOrigin } from '../../plans/planning.js';
import { proposePlanAmendment } from '../../plans/planAmendment.js';
import { currentPlanSummary } from '../../plans/parts.js';
import { PLAN_DOCUMENT_SCHEMA } from '../planDocumentSchema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

/**
 * An agent's way of saying **the plan is wrong** without stopping the run.
 *
 * The agent working a part is the reader most likely to find out that the
 * decomposition was written against a repository nobody had read closely enough —
 * a dependency the other way round, a part that turns out to be two, a step the
 * code already does. Until now the only thing it could do with that was write it
 * into a conclusion and hope, or park the whole goal for a replan; both cost the
 * run, and the second re-derives a decomposition that was mostly right.
 *
 * So this proposes a correction and nothing else: the row goes to
 * `plan_amendments`, rule `plan-amendment` puts it to the operator, and **the plan
 * carries on scheduling in the meantime** — including the part this agent is
 * working, which is not stopped, held or re-dispatched by anything here.
 *
 * `plan_correct` and not `plan_amend`: the desktop channel's tool of that name
 * writes an `awaiting_approval` plan in place, and one name over two different
 * settlements is the `validation_report` trap `names.ts` spells out. They share
 * the document schema, which is one export, and nothing else.
 */
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
  inputSchema: {
    ...PLAN_DOCUMENT_SCHEMA,
    properties: {
      note: {
        type: 'string',
        description:
          'Why the plan must change, in a few sentences. This is the whole of what the operator reads beside ' +
          'the diff, so say what you found and where — a correction with no reason on it is one they cannot ' +
          'answer.',
      },
      ...((PLAN_DOCUMENT_SCHEMA.properties ?? {}) as Record<string, unknown>),
    },
    required: ['note', ...((PLAN_DOCUMENT_SCHEMA.required ?? []) as string[])],
  },
  handler: (args) => {
    const issue = originIssueNumber(task.originRef);
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
        // Passed through rather than defaulted, for `plan_submit`'s reason: absent
        // means "leave the existing checks alone", and an empty block would read at
        // ingestion as a withdrawal of every check somebody is halfway through.
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
      // What the operator will be shown, handed back so the agent can see the
      // change it actually described rather than the one it meant to.
      changes: proposed.proposed.diff?.parts.filter((p) => p.kind !== 'unchanged').map((p) => `${p.kind} ${p.slug}`),
      ...(proposed.proposed.warnings.length > 0 ? { warnings: proposed.proposed.warnings } : {}),
      // The plan as it stands *now*, which is what your part is still being judged
      // against — said out loud because the one thing an agent must not infer from
      // a successful call here is that the amended plan is in force.
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
