import { z } from 'zod';
import { toolSchema } from '../schema.js';
import { toolJson } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const requestPermission: ToolFactory = ({ deps, agent, task }) => ({
  description:
    'Harness-internal. You do not call this — Claude Code invokes it through --permission-prompt-tool ' +
    'when one of your tool calls is not covered by the operator allow-list, to ask the operator to ' +
    'allow or deny it. It blocks until they decide and returns the verdict.',
  inputSchema: toolSchema(
    z.object({
      tool_name: z.string().describe('The tool the permission is for.').optional(),
      input: z.record(z.unknown()).describe('The tool input awaiting approval.').optional(),
      tool_use_id: z.string().describe('Claude Code’s id for this tool use.').optional(),
    }),
  ),
  handler: async (args) => {
    if (!deps.permissions) {
      return toolJson({ behavior: 'deny', message: 'The permission backstop is disabled.' });
    }
    const toolName = typeof args.tool_name === 'string' && args.tool_name ? args.tool_name : 'a tool';
    const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
    const verdict = await deps.permissions.request(agent, task, toolName, input);
    return toolJson(verdict);
  },
});
