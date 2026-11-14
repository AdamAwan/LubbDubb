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
    'Read the stored sample message and stack of one app error group in your run. They can carry user data, ' +
    'so ask only when the frames and the code have not told you enough; every read is recorded and shown to ' +
    'the operator on the Errors tab. Never quote either in your verdict.',
  inputSchema: toolSchema(AppErrorDetailArgs),
  handler: (args) => {
    const parsed = AppErrorDetailArgs.safeParse(args);
    if (!parsed.success) return toolError(`Detail refused: ${parsed.error.message}`);
    const result = deps.agents.readAppErrorDetail(agent.id, parsed.data.key);
    if (!result.ok) return toolError(result.error);
    return ok({
      key: result.key,
      message: result.message,
      stack: result.stack,
      note:
        result.message === null && result.stack === null
          ? 'The telemetry reported no sample message or stack for this group.'
          : 'This read has been recorded.',
    });
  },
});
