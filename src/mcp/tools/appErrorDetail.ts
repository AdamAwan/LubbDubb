import { z } from 'zod';
import { toolSchema } from '../schema.js';
import { toolError } from '../protocol.js';
import type { ToolFactory } from './context.js';
import { MAX_DETAIL_OUTPUT_CHARS, type AppErrorDetailOutput } from '../../appErrors/detailCommand.js';

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
    const { detailQuery, note } = queryReport(result.query);
    return ok({
      key: result.key,
      message: result.message,
      stack: result.stack,
      detailQuery,
      note: [
        result.message === null && result.stack === null
          ? 'The telemetry reported no sample message or stack for this group.'
          : null,
        note,
        'This read has been recorded.',
      ]
        .filter((n) => n !== null)
        .join(' '),
    });
  },
});

function queryReport(query: AppErrorDetailOutput | null): {
  detailQuery: { output: string; truncated: boolean } | { failed: string } | null;
  note: string;
} {
  if (query === null)
    return {
      detailQuery: null,
      note: 'This environment declares no detail query, so nothing more can be asked of its telemetry.',
    };
  if (!query.ok)
    return {
      detailQuery: { failed: query.failure },
      note: 'The detail query failed; the failure is above. Work from what you have.',
    };
  return {
    detailQuery: { output: query.text, truncated: query.truncated },
    note: query.truncated
      ? `The detail query ran; its output was cut to its first ${MAX_DETAIL_OUTPUT_CHARS.toLocaleString('en-US')} characters.`
      : 'The detail query ran.',
  };
}
