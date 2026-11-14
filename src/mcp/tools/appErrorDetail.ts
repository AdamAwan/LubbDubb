import { z } from 'zod';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md, docs/spec/39-app-errors.md#agent-triage

const AppErrorDetailArgs = z.object({
  key: z.string().describe('The group’s key, err:<project>:<hash>, as its heading in your brief gives it.'),
});

export const appErrorDetail: ToolFactory = ({ deps, agent, ok }) => ({
  description:
    'Read the stored sample message and stack of one app error group in your run and, where its environment ' +
    'declares a detail query, run that query against the telemetry for this group and return what it prints. ' +
    'Both can carry user data, so ask only when the frames and the code have not told you enough; every read ' +
    'is recorded and shown to the operator on the Errors tab. Never quote either in your verdict.',
  inputSchema: toolSchema(AppErrorDetailArgs),
  handler: async (args) => {
    const parsed = AppErrorDetailArgs.safeParse(args);
    if (!parsed.success) return toolError(`Detail refused: ${parsed.error.message}`);
    const result = await deps.agents.readAppErrorDetail(agent.id, parsed.data.key);
    if (!result.ok) return toolError(result.error);
    const { query } = result;
    return ok({
      key: result.key,
      message: result.message,
      stack: result.stack,
      detailQuery:
        query === null
          ? null
          : query.ok
            ? { output: query.text, truncated: query.truncated }
            : { failed: query.failure },
      note: [
        result.message === null && result.stack === null
          ? 'The telemetry reported no sample message or stack for this group.'
          : null,
        query === null
          ? 'This environment declares no detail query, so nothing more can be asked of its telemetry.'
          : query.ok
            ? query.truncated
              ? 'The detail query ran; its output was cut to its first 32,000 characters.'
              : 'The detail query ran.'
            : 'The detail query failed; the failure is above. Work from what you have.',
        'This read has been recorded.',
      ]
        .filter((n) => n !== null)
        .join(' '),
    });
  },
});
