import { validatePlanNotNeeded } from '../planNotNeeded.js';
import { toolError } from '../protocol.js';
import { DONE_REMINDER } from '../../agents/agentProtocol.js';
import type { ToolFactory } from './context.js';

export const planNotNeeded: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say that the issue you were dispatched to plan needs no plan, because what it asks for is ' +
    'already there. This is the planner\'s other verdict, and it exists so that "there is nothing ' +
    'to build" does not have to be written as a plan with a part in it — a part invented to fit ' +
    'the shape costs an agent, a branch and sometimes a pull request to discover what you already ' +
    'know. Use it only for a goal that is *met*: the code, the setting or the document the ticket ' +
    'asks for is in the repository now. A goal you cannot make sense of is not this — that is a ' +
    'plan you should not be writing either, and the honest move there is to raise it. The harness ' +
    'schedules nothing further for the issue while your verdict stands; it does not close the ' +
    'ticket, and an operator can undo it.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'One line, no line breaks: what the issue asked for and where it already is. This is the ' +
          'headline an operator reads before anything else — the evidence belongs in `detail`, and a ' +
          'summary with a line break in it is refused.',
      },
      detail: {
        type: 'string',
        description:
          'Required: the working behind the verdict. The files, commits or pull requests that already do ' +
          'what the ticket asks, and what you checked to be sure nothing it asks for is missing. Markdown, ' +
          'rendered as the body of the card an operator reads. If you cannot point at anything, you are ' +
          'not sure enough to say this — plan the work instead.',
      },
    },
    required: ['summary', 'detail'],
  },
  handler: (args) => {
    const parsed = validatePlanNotNeeded(args);
    if (!parsed.ok) return toolError(`Verdict rejected: ${parsed.error}`);
    // Structural identity, and here it decides whether there is anything to
    // report at all: every other kind of agent is refused by name and pointed at
    // the verdict that is its own. The plan-aware refusals happen there too —
    // this layer cannot read a plan or a standing shortfall.
    const result = deps.agents.recordGoalMet(agent.id, parsed.summary, parsed.detail);
    if (!result.ok) return toolError(result.error);
    return ok({
      recorded: true,
      issue: result.issueOrigin,
      // Said out loud rather than left to be inferred: a planner that believed it
      // had closed the ticket would stop looking at it, and one that believed it
      // had merely declined to plan would go on to write a plan anyway.
      note:
        'Recorded as a delivery verdict on the issue. Nothing further is scheduled for it while that ' +
        'stands — no plan, and no implementation agent. It ends if the issue changes in the tracker or ' +
        'an operator clears it. The ticket is not closed; that stays a human decision. Do not submit a ' +
        'plan as well. ' +
        DONE_REMINDER,
    });
  },
});
