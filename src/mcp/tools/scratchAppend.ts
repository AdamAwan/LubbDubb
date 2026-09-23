import { z } from 'zod';
import { normalisePadNote } from '../../scratch/pad.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const scratchAppend: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Leave a note on the shared scratchpad for the issue — or the pull request — you are working. Every ' +
    'agent on this goal — the parts before and after yours, and the retrospective written at the end — ' +
    'reads the same pad. ' +
    'Write what a colleague taking over would need: what you tried that did not work, a constraint you ' +
    'found the hard way, a surprise in the code. Entries are append-only and attributed to you, nothing is dispatched from them, and nobody is obliged to act ' +
    'on one. This is not a status line (use note_progress) and not a report about work outside your ' +
    'own task (use report_finding).',
  inputSchema: toolSchema(
    z.object({
      note: z.string().describe('What you learned or tried, in plain words.'),
      topic: z.string().describe('Optional short tag for scanning, e.g. "store", "ci", "the merge gate".').optional(),
    }),
  ),
  handler: (args) => {
    const parsed = normalisePadNote(args.note, args.topic);
    if (!parsed.ok) return toolError(`Note rejected: ${parsed.error}`);
    const result = deps.agents.appendScratch(agent.id, parsed.note, parsed.topic, null);
    if (!result.ok) return toolError(result.error);
    return ok({
      appended: true,
      pad: result.entry.padRef,
      trimmed: parsed.trimmed,
      note: parsed.trimmed
        ? 'Recorded, trimmed to fit. Nothing is scheduled from a pad entry.'
        : 'Recorded. Nothing is scheduled from a pad entry.',
    });
  },
});
