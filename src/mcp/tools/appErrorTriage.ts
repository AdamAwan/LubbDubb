import { z } from 'zod';
import { MAX_TRIAGE_REASON } from '../../appErrors/triageRecord.js';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md, docs/spec/39-app-errors.md#agent-triage

const AppErrorTriageArgs = z.object({
  key: z.string().describe('The group’s key, err:<project>:<hash>, as its heading in your brief gives it.'),
  verdict: z
    .enum(['caused-by', 'pre-existing', 'unclear'])
    .describe(
      'caused-by: one of this group’s candidate goals probably introduced it — name it in goalRef. ' +
        'pre-existing: the fault was there before any candidate landed, and traffic or data found it. ' +
        'unclear: you could not tell; say what you would need in reason.',
    ),
  goalRef: z
    .string()
    .optional()
    .describe(
      'Only with caused-by, and required there: the candidate goal, as the brief lists it (issue:412) or as #412.',
    ),
  confidence: z
    .enum(['low', 'medium', 'high'])
    .describe('How sure you are, read as a person deciding where to look first.'),
  reason: z
    .string()
    .describe(
      `Two or three sentences, ${String(MAX_TRIAGE_REASON)} characters at the outside, for the operator: what ` +
        'you followed and what it showed — the frame, the file, the change. Never paste the error message or the stack.',
    ),
});

export const appErrorTriage: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Say which goal probably caused one app error group in your run, or that it is pre-existing, or that you ' +
    'cannot tell. Call it once for every group you were handed; calling it again for the same group replaces ' +
    'what you said. It is drawn beside the group on the Errors tab and nowhere else: nothing is filed or gated from it.',
  inputSchema: toolSchema(AppErrorTriageArgs),
  handler: (args) => {
    const parsed = AppErrorTriageArgs.safeParse(args);
    if (!parsed.success) return toolError(`Triage rejected: ${parsed.error.message}`);
    const { key, verdict, goalRef, confidence, reason } = parsed.data;
    const result = deps.agents.recordAppErrorTriage(agent.id, {
      key,
      verdict,
      goalRef: goalRef ?? null,
      confidence,
      reason,
    });
    if (!result.ok) return toolError(result.error);
    return ok({
      recorded: true,
      remaining: result.remaining,
      note:
        result.remaining.length === 0
          ? 'Recorded. That was the last group in the run; you are done.'
          : `Recorded. Still to do: ${result.remaining.join(', ')}.`,
    });
  },
});
