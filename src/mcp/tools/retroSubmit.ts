import { z } from 'zod';
import { MAX_RETRO_MISSES, RETRO_MISS_CAUSES, validateRetroMisses, validateRetrospective } from '../../retro/retro.js';
import { CAUSE_COPY, GUARD_COPY, GUARD_ORDER } from '../../remedies/remedies.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const retroSubmit: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Submit the retrospective for the issue you were dispatched to write up. Two audiences, one ' +
    'document: **what shipped** — the pull requests, what each part decided, what was concluded out ' +
    'of scope or needed no code, anything still outstanding — and **how the run went**, for the ' +
    'operator: where agents were spent and why, which gates or escalations cost time, what surprised ' +
    'the agents, what you would change about the process. You have the scratchpad the working agents ' +
    'left and the record the harness kept; reconcile them and say where they disagree. This schedules ' +
    'nothing, closes nothing and is posted nowhere — a human reads it and decides what to change.\n\n' +
    'Anything this run taught that outlives the goal — a seam, an invariant, a defect you noticed in ' +
    'passing — goes in the document itself, for the operator to act on. Something true only of this ' +
    'goal belongs in the scratchpad, where it dies with the goal, correctly.',
  inputSchema: toolSchema(
    z.object({
      summary: z
        .string()
        .describe(
          'One or two sentences: what was delivered, and the one thing about this run worth knowing. ' +
            'This is what an operator sees before deciding to open the document.',
        ),
      document: z.string().describe('The write-up itself, in markdown.'),
      misses: z
        .array(
          z.object({
            cause: z
              .enum(RETRO_MISS_CAUSES as [string, ...string[]])
              .describe(RETRO_MISS_CAUSES.map((c) => `${c}: ${CAUSE_COPY[c].blurb}`).join('. ')),
            guard: z.enum(GUARD_ORDER).describe(GUARD_ORDER.map((g) => `${g}: ${GUARD_COPY[g].blurb}`).join('. ')),
            path: z
              .string()
              .describe('The repository-relative path of a file the miss was about, e.g. src/api/routes.ts.'),
            summary: z.string().describe('One line: what was missed, and what it cost the goal.'),
          }),
        )
        .max(MAX_RETRO_MISSES)
        .optional()
        .describe(
          `Up to ${MAX_RETRO_MISSES} misses this goal paid for, each a cause, a guard and a file. An empty ` +
            'list when the run had none. On a revision, left out keeps the misses already recorded; a list replaces them.',
        ),
    }),
  ),
  handler: (args) => {
    const parsed = validateRetrospective(args);
    if (!parsed.ok) return toolError(`Retrospective rejected: ${parsed.error}`);
    const misses = validateRetroMisses(args.misses);
    if (!misses.ok) return toolError(`Retrospective rejected: ${misses.error}`);
    const result = deps.agents.recordRetrospective(agent.id, parsed.summary, parsed.document, misses.misses);
    if (!result.ok) return toolError(result.error);
    return ok({
      filed: true,
      issue: result.issueOrigin,
      trimmed: parsed.trimmed,
      misses: misses.misses?.length ?? null,
      note:
        'Recorded. It is read in the cockpit on the goal that produced it; nothing is posted to the ' +
        'tracker, nothing is closed, and nothing is scheduled from it.',
    });
  },
});
