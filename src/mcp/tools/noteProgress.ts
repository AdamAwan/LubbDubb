import { normaliseNote } from '../progress.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const noteProgress: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say in one line what you are working on right now, so an operator watching the fleet can ' +
    "see it without reading your transcript. Replaces your card's preview line, which is " +
    'otherwise just whatever you last printed. Call it when you move on to a different part of ' +
    'the task, or before a long step (a full test run, a big refactor) so the quiet is explained. ' +
    'It is optional and it costs you nothing to skip: nothing infers that you are stuck from a ' +
    'gap between notes, so do not call it to prove you are alive. It asks nothing and changes ' +
    'nothing about your task — if you need a decision, use escalate instead.',
  inputSchema: {
    type: 'object',
    properties: {
      note: {
        type: 'string',
        description:
          'One line, present tense, in the words you would use to a colleague: "reading how the ' +
          'dispatcher ranks candidates", "running the full suite after the rename". Say what you ' +
          'are doing, not that you are doing well.',
      },
    },
    required: ['note'],
  },
  handler: (args) => {
    const parsed = normaliseNote(args.note);
    if (!parsed.ok) return toolError(parsed.error);
    // Structural attribution, exactly as for `report_finding` and for the same
    // reason: this is a write that speaks in an agent's name to an operator.
    // There is no argument naming an agent, so there is nothing to forge with.
    const result = deps.agents.recordProgress(agent.id, parsed.note);
    if (!result.ok) return toolError(result.error);
    return ok({
      noted: true,
      note: parsed.note,
      notedAt: result.notedAt,
      ...(parsed.trimmed
        ? // Stored anyway rather than refused — a trimmed status line still
          // answers the question a rejected one would have left blank — but the
          // caller hears that it was cut so the next one fits.
          { trimmed: `Kept, trimmed to one line. Shorter notes read better on the card.` }
        : {}),
    });
  },
});
