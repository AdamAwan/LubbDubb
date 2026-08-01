import { GOAL_ASSAY_VERDICT_HELP, GOAL_ASSAY_VERDICTS, validateGoalAssay } from '../goalAssay.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const assayIssue: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say whether the ISSUE you were dispatched to assay can be worked from at all. You are standing in ' +
    'front of the work, not doing it: nothing has been dispatched for this issue yet, and your verdict ' +
    'decides whether anything is. Read the ticket against the repository you are in. Say "workable" ' +
    'if there is an identifiable goal an agent could start on — the bar is *actionable*, not *good*, ' +
    'and a large or opinionated ticket is still workable. Say "unclear" only when starting would be ' +
    'guessing: nobody could tell what "done" means, the ticket contradicts itself or the repository, ' +
    'or it refers to things that do not exist. An "unclear" verdict stops the harness scheduling ' +
    'anything for this issue until the ticket is edited, someone comments on it, or a human overrides ' +
    'you — so it is a question you are asking a person, and your summary is the whole of what they ' +
    'have to answer. Do not implement anything and do not open a pull request.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: [...GOAL_ASSAY_VERDICTS],
        description: GOAL_ASSAY_VERDICTS.map((v) => `${v}: ${GOAL_ASSAY_VERDICT_HELP[v]}`).join('. '),
      },
      summary: {
        type: 'string',
        description:
          'For "unclear": precisely what you would need in order to start, phrased for the person who ' +
          'wrote the ticket — the specific question, not "it is vague". For "workable": one sentence ' +
          'saying what you understood the goal to be, so a wrong reading is visible before an agent ' +
          'acts on it.',
      },
    },
    required: ['status', 'summary'],
  },
  handler: (args) => {
    const parsed = validateGoalAssay(args);
    if (!parsed.ok) return toolError(`Assay rejected: ${parsed.error}`);
    // Structural identity, and here it decides whether there is anything to
    // assay at all: an agent already doing the work is refused rather than
    // scoped down, because it would be parking an issue it is mid-way through.
    const result = deps.agents.recordAssay(agent.id, parsed.verdict, parsed.summary);
    if (!result.ok) return toolError(result.error);
    return ok({
      assayed: true,
      issue: result.issueOrigin,
      status: result.verdict,
      note:
        parsed.verdict === 'workable'
          ? 'Recorded. The issue proceeds exactly as it would have — this verdict schedules nothing ' +
            'itself, it only stops the assay being asked again for this version of the ticket.'
          : 'Recorded. Nothing is dispatched for this issue while the verdict stands. It ends by ' +
            'itself the moment the ticket is edited or anything happens on it, and an operator can ' +
            'clear it outright. The ticket is not closed and nothing is rejected — that stays a ' +
            'human decision.',
    });
  },
});
