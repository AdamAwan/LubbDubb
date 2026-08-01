import { validateRetrospective } from '../../retro/retro.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const retroSubmit: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Submit the retrospective for the issue you were dispatched to write up. Two audiences, one ' +
    'document: **what shipped** — the pull requests, what each part decided, what was concluded out ' +
    'of scope or needed no code, anything still outstanding — and **how the run went**, for the ' +
    'operator: where agents were spent and why, which gates or escalations cost time, what surprised ' +
    'the agents, what you would change about the process. You have the scratchpad the working agents ' +
    'left and the record the harness kept; reconcile them and say where they disagree. This schedules ' +
    'nothing, closes nothing and is posted nowhere — a human reads it and decides what to change.',
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'One or two sentences: what was delivered, and the one thing about this run worth knowing. ' +
          'This is what an operator sees before deciding to open the document.',
      },
      document: { type: 'string', description: 'The write-up itself, in markdown.' },
    },
    required: ['summary', 'document'],
  },
  handler: (args) => {
    const parsed = validateRetrospective(args);
    if (!parsed.ok) return toolError(`Retrospective rejected: ${parsed.error}`);
    const result = deps.agents.recordRetrospective(agent.id, parsed.summary, parsed.document);
    if (!result.ok) return toolError(result.error);
    return ok({
      filed: true,
      issue: result.issueOrigin,
      trimmed: parsed.trimmed,
      note:
        'Recorded. It is read in the cockpit on the goal that produced it; nothing is posted to the ' +
        'tracker, nothing is closed, and nothing is scheduled from it.',
    });
  },
});
