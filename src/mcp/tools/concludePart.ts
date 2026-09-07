import { z } from 'zod';
import { PART_OUTCOME_KIND_HELP, PART_OUTCOME_KINDS, validatePartConclusion } from '../partOutcome.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import { DONE_REMINDER } from '../../agents/agentProtocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const concludePart: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Close YOUR PART of a decomposed issue when it finished without a pull request. Most parts end in ' +
    'a merged PR and need nothing from you — the harness sees the merge itself. Call this only when ' +
    'there is no PR to open: the part was a write-up or a measurement ("report"), or you established ' +
    'that nothing needs building at all ("determination" — it is already done, it duplicates other ' +
    'work, or the premise was wrong). Without it a part like that stays open forever and holds the ' +
    'whole plan, and its issue, open with it. This says nothing about the other parts or about ' +
    'whether the issue as a whole is finished.',
  inputSchema: toolSchema(
    z.object({
      kind: z
        .enum(PART_OUTCOME_KINDS)
        .describe(PART_OUTCOME_KINDS.map((k) => `${k}: ${PART_OUTCOME_KIND_HELP[k]}`).join('. ')),
      summary: z
        .string()
        .describe(
          'What you produced or found. An operator reads this to decide what the plan achieved, and ' +
            'for a determination it is the entire record of why no code was written — so give the ' +
            'evidence, not just the conclusion.',
        ),
      evidenceRef: z
        .string()
        .describe(
          'Optional: "flag:<id>" for an artifact you surfaced, or "finding:<id>" for something you ' +
            'reported with report_finding. Omit it if you have neither.',
        )
        .optional(),
    }),
  ),
  handler: (args) => {
    const parsed = validatePartConclusion(args);
    if (!parsed.ok) return toolError(`Part conclusion rejected: ${parsed.error}`);
    const result = deps.agents.recordPartOutcome(agent.id, parsed.kind, parsed.summary, parsed.ref);
    if (!result.ok) return toolError(result.error);
    return ok({
      concluded: true,
      part: result.part.slug,
      outcome: result.part.outcomeKind,
      note:
        'Recorded. This part is finished and nothing further is dispatched for it. The rest of the ' +
        'plan is unaffected, and whether the issue itself is done is decided by the plan as a whole. ' +
        DONE_REMINDER,
    });
  },
});
