import { ASSESSMENT_VERDICT_HELP, ASSESSMENT_VERDICTS, validateAssessment } from '../assessment.js';
import { SHORTFALL_CAUSE_HELP, SHORTFALL_CAUSES, shortfallRecordedNote } from '../../delivery/shortfall.js';
import { toolError } from '../protocol.js';
import { DONE_REMINDER } from '../../agents/agentProtocol.js';
import type { ToolFactory } from './context.js';

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
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...ASSESSMENT_VERDICTS],
        description: ASSESSMENT_VERDICTS.map((v) => `${v}: ${ASSESSMENT_VERDICT_HELP[v]}`).join('. '),
      },
      summary: {
        type: 'string',
        description:
          'One line, no line breaks: the verdict and what decided it. This is the headline an operator ' +
          'reads before anything else — the evidence belongs in `detail`, and a summary with a line break ' +
          'in it is refused.',
      },
      detail: {
        type: 'string',
        description:
          'The account behind the verdict: which pull requests delivered what, whether the harness watched ' +
          'them merge or assumed it, and for more_work precisely what is missing — the next agent starts ' +
          'from this. Markdown, rendered as the body of the card an operator reads, so use headings and ' +
          'lists for structure and a fenced code block for output. Optional; write nothing if the headline ' +
          'says it all.',
      },
      cause: {
        type: 'string',
        enum: [...SHORTFALL_CAUSES],
        description:
          'more_work only, and required when the issue has a plan: what fell short. ' +
          SHORTFALL_CAUSES.map((c) => `${c}: ${SHORTFALL_CAUSE_HELP[c]}`).join('. ') +
          '. Nothing happens without a human accepting it first, so pick the honest one rather than ' +
          'the one you think will be approved.',
      },
      part: {
        type: 'string',
        description:
          'The slug of the part that fell short, exactly as the plan declares it. Required for ' +
          'cause "part" and meaningless for the others.',
      },
    },
    required: ['status', 'summary'],
  },
  handler: (args) => {
    const parsed = validateAssessment(args);
    if (!parsed.ok) return toolError(`Assessment rejected: ${parsed.error}`);
    // Structural identity, and here it decides whether there is anything to
    // assess at all: an agent that did the work is refused rather than scoped
    // down, because judging your own delivery is not an assessment. The
    // plan-aware refusals happen there too — this layer cannot read a plan.
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
      // The finish reminder rides on every terminal tool's response — see
      // {@link DONE_REMINDER} for why the system prompt alone is not enough.
      note:
        (parsed.verdict === 'delivered'
          ? 'Recorded. The harness will not pick this issue up again while the verdict stands — it ends ' +
            'when the issue changes in the tracker or someone clears it. The ticket is not closed; that ' +
            'stays a human decision.'
          : shortfallRecordedNote(parsed.cause)) +
        ' ' +
        DONE_REMINDER,
    });
  },
});
