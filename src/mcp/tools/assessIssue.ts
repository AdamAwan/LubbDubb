import { z } from 'zod';
import { ASSESSMENT_VERDICT_HELP, ASSESSMENT_VERDICTS, validateAssessment } from '../assessment.js';
import { toolSchema } from '../schema.js';
import { SHORTFALL_CAUSE_HELP, SHORTFALL_CAUSES, shortfallRecordedNote } from '../../delivery/shortfall.js';
import { toolError } from '../protocol.js';
import { DONE_REMINDER } from '../../agents/agentProtocol.js';
import { checkSetAuthored } from '../../validation/authoring.js';
import type { McpToolDeps, ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

/**
 * What a `delivered` verdict leaves owed. The assessor writes the goal's check set in the same turn
 * ([20](docs/spec/20-validation.md#when-the-check-set-is-written)), and the tool's own answer says so
 * as well as the prompt does — an operator override of `issue-assess` carries its own body, and this
 * is what makes the fold reach one anyway. Silent for a goal with no plan or a set somebody has
 * already written, which are the two gates `validation_plan` itself refuses on — and silent where
 * `validation.checkSets` is off, which is the third: nothing is owed where no rule would ever put the
 * set to anybody. → docs/spec/20-validation.md#the-authoring-gate
 */
function checkSetOwed(deps: McpToolDeps, origin: string): boolean {
  if (deps.checkSets !== true) return false;
  if (deps.store.plans.getPlanByOrigin(origin) === null) return false;
  return !checkSetAuthored({
    record: deps.store.validation.getValidationPlanRecord(origin),
    checks: deps.store.validation.listValidationChecks(origin),
  });
}

export const assessIssue: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say whether the ISSUE you were dispatched to assess is finished. You are the second look: ' +
    'another agent did the work and said what it believed it delivered, and your job is to check ' +
    "that against the repository you are standing in and the harness's record of what was done " +
    '(world_read on your issue). Say "delivered" only if what the issue asked for is actually ' +
    'present — that stops the harness scheduling anything further, though it does not close the ' +
    'ticket and can be undone. Say "more_work" if something is missing or you could not verify it — ' +
    'then say in `cause` WHICH of three things fell short, because the harness routes each of them ' +
    'differently and cannot guess. If you are torn, say more_work: a wrong "delivered" parks real ' +
    'work silently, a wrong "more_work" costs one agent.',
  inputSchema: toolSchema(
    z.object({
      status: z
        .enum(ASSESSMENT_VERDICTS)
        .describe(ASSESSMENT_VERDICTS.map((v) => `${v}: ${ASSESSMENT_VERDICT_HELP[v]}`).join('. ')),
      summary: z
        .string()
        .describe(
          'One line, no line breaks: the verdict and what decided it. This is the headline an operator ' +
            'reads before anything else — the evidence belongs in `detail`, and a summary with a line break ' +
            'in it is refused.',
        ),
      detail: z
        .string()
        .describe(
          'The account behind the verdict: which pull requests delivered what, whether the harness watched ' +
            'them merge or assumed it, and for more_work precisely what is missing — the next agent starts ' +
            'from this. Markdown, rendered as the body of the card an operator reads, so use headings and ' +
            'lists for structure and a fenced code block for output. Optional; write nothing if the headline ' +
            'says it all.',
        )
        .optional(),
      cause: z
        .enum(SHORTFALL_CAUSES)
        .describe(
          'more_work only, and required when the issue has a plan: what fell short. ' +
            SHORTFALL_CAUSES.map((c) => `${c}: ${SHORTFALL_CAUSE_HELP[c]}`).join('. ') +
            '. Nothing happens without a human accepting it first, so pick the honest one rather than ' +
            'the one you think will be approved.',
        )
        .optional(),
      part: z
        .string()
        .describe(
          'The slug of the part that fell short, exactly as the plan declares it. Required for ' +
            'cause "part" and meaningless for the others.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const parsed = validateAssessment(args);
    if (!parsed.ok) return toolError(`Assessment rejected: ${parsed.error}`);
    const result = deps.agents.recordAssessment(
      agent.id,
      parsed.verdict,
      parsed.summary,
      parsed.detail,
      parsed.cause,
      parsed.part,
    );
    if (!result.ok) return toolError(result.error);
    return ok({
      assessed: true,
      issue: result.issueOrigin,
      status: result.verdict,
      cause: parsed.cause,
      note:
        (parsed.verdict === 'delivered'
          ? 'Recorded. The harness will not pick this issue up again while the verdict stands — it ends ' +
            'when the issue changes in the tracker or someone clears it. The ticket is not closed; that ' +
            'stays a human decision.'
          : shortfallRecordedNote(parsed.cause)) +
        ' ' +
        (parsed.verdict === 'delivered' && checkSetOwed(deps, result.issueOrigin)
          ? 'One thing is still owed: this goal has no validation check set, and you are standing in the ' +
            'delivered code it is written against. Declare it now with validation_plan — the whole set in ' +
            'one call — and then finish. If you cannot, say so and stop: a validation planner is dispatched ' +
            'for a delivered goal that has none, so nothing is lost. ' +
            DONE_REMINDER
          : DONE_REMINDER),
    });
  },
});
