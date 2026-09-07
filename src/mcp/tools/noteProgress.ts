import { z } from 'zod';
import { normaliseNote } from '../progress.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const noteProgress: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say in one line what you are working on right now, so an operator watching the fleet can ' +
    "see it without reading your transcript. Replaces your card's preview line, which is " +
    'otherwise just whatever you last printed. Call it when you move on to a different part of ' +
    'the task, or before a long step (a full test run, a big refactor) so the quiet is explained. ' +
    'It is optional and it costs you nothing to skip: nothing infers that you are stuck from a ' +
    'gap between notes, so do not call it to prove you are alive. It asks nothing and changes ' +
    'nothing about your task — if you need a decision, use escalate instead.',
  inputSchema: toolSchema(
    z.object({
      note: z
        .string()
        .describe(
          'One line, present tense, in the words you would use to a colleague: "reading how the ' +
            'dispatcher ranks candidates", "running the full suite after the rename". Say what you ' +
            'are doing, not that you are doing well.',
        ),
    }),
  ),
  handler: (args) => {
    const parsed = normaliseNote(args.note);
    if (!parsed.ok) return toolError(parsed.error);
    const result = deps.agents.recordProgress(agent.id, parsed.note);
    if (!result.ok) return toolError(result.error);
    return ok({
      noted: true,
      note: parsed.note,
      notedAt: result.notedAt,
      ...(parsed.trimmed ? { trimmed: `Kept, trimmed to one line. Shorter notes read better on the card.` } : {}),
    });
  },
});
