import { validateHumanTask } from '../humanTasks.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const requestHumanTask: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Ask for work that only a PERSON can do — flipping a setting in a console you have no account ' +
    'for, plugging something in, looking at a rendered screen and saying whether it is right. It ' +
    'lands in the cockpit as work an operator can mark done or decline, it survives you, and it ' +
    'survives a restart. ' +
    'Use escalate instead when you need an ANSWER to carry on: that parks you until a human replies. ' +
    'Use this when you need a human to DO something, which may take until tomorrow — file it and ' +
    'get on with, or conclude, whatever you can. It dispatches nobody and blocks nothing by itself.',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description:
          'What the person must do, on ONE line under 160 characters, phrased as an instruction ' +
          '("Enable the staging webhook in the Stripe dashboard"). No newlines: an operator scans ' +
          'this in a list. Everything else goes in detail.',
      },
      detail: {
        type: 'string',
        description:
          'How to do it and how to know it is done, in markdown: the exact setting, the URL, what ' +
          'the right answer looks like. Assume the reader has not read your transcript. Omit it ' +
          'only when the title genuinely says everything.',
      },
    },
    required: ['title'],
  },
  handler: (args) => {
    // Validated at the boundary with the reason handed back — a malformed ask is a
    // fixable error in this turn rather than an unreadable card an operator meets
    // hours later, which is the whole point of a tool over a PR comment.
    const parsed = validateHumanTask(args);
    if (!parsed.ok) return toolError(`Human task rejected: ${parsed.error}`);
    // Attribution is the credential's, never an argument's. This is a write that
    // puts an obligation on a person under an agent's name, so it must say
    // truthfully which agent asked and what it was working on.
    const result = deps.agents.requestHumanTask(agent.id, parsed.input);
    if (!result.ok) return toolError(result.error);
    return ok({
      recorded: true,
      humanTask: { id: result.task.id, title: result.task.title, status: result.task.status },
      // Said again in the response, not only in the description: an agent that
      // believes filing this arranged something will sit waiting for it.
      note:
        'Filed for an operator, who may do it or decline it. Nobody is dispatched and nothing is ' +
        'blocked on it — do not wait for it. If your own work cannot finish without it, say so in ' +
        'your conclusion rather than stalling.',
    });
  },
});
