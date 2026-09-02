import { normalisePadDecision, normalisePadNote } from '../../scratch/pad.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

export const scratchAppend: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Leave a note on the shared scratchpad for the issue — or the pull request — you are working. Every ' +
    'agent on this goal — the parts before and after yours, and the retrospective written at the end — ' +
    'reads the same pad. ' +
    'Write what a colleague taking over would need: what you tried that did not work, a constraint you ' +
    'found the hard way, why you chose one approach over another, a surprise in the code. Entries are ' +
    'append-only and attributed to you, nothing is dispatched from them, and nobody is obliged to act ' +
    'on one. This is not a status line (use note_progress) and not a report about work outside your ' +
    'own task (use report_finding). Add a `decision` when the entry records a fork — a moment the ' +
    'change could reasonably have gone another way — with what you chose, why, and the alternatives ' +
    'you rejected; an entry without one is an ordinary note.',
  inputSchema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'What you learned, tried, or decided, in plain words.' },
      topic: {
        type: 'string',
        description: 'Optional short tag for scanning, e.g. "store", "ci", "the merge gate".',
      },
      decision: {
        type: 'object',
        description:
          'Present only on a fork. One line each: what you chose here and why, the alternatives you ' +
          'rejected with the reason for each, and the files the fork touches where you can say.',
        properties: {
          chose: { type: 'string', description: 'What the change does here, in one line.' },
          because: { type: 'string', description: 'Why, in one line.' },
          rejected: {
            type: 'array',
            description: 'The alternatives not taken, each with its reason. May be empty.',
            items: {
              type: 'object',
              properties: {
                alternative: { type: 'string' },
                because: { type: 'string' },
              },
              required: ['alternative', 'because'],
            },
          },
          paths: {
            type: 'array',
            description: 'The files this fork touches, where you can say. May be empty.',
            items: { type: 'string' },
          },
        },
        required: ['chose', 'because'],
      },
    },
    required: ['note'],
  },
  handler: (args) => {
    const parsed = normalisePadNote(args.note, args.topic);
    if (!parsed.ok) return toolError(`Note rejected: ${parsed.error}`);
    // Refused by field name rather than stored as a note: a fork the log lost in
    // silence is the one thing the witness log exists not to do.
    const fork = normalisePadDecision(args.decision);
    if (!fork.ok) return toolError(`Decision rejected: ${fork.error}`);
    const result = deps.agents.appendScratch(agent.id, parsed.note, parsed.topic, fork.decision);
    if (!result.ok) return toolError(result.error);
    const trimmed = parsed.trimmed || fork.trimmed;
    return ok({
      appended: true,
      pad: result.entry.padRef,
      fork: fork.decision !== null,
      trimmed,
      note: trimmed
        ? 'Recorded, trimmed to fit. Nothing is scheduled from a pad entry.'
        : 'Recorded. Nothing is scheduled from a pad entry.',
    });
  },
});
