import { toolJson } from '../protocol.js';
import type { ToolFactory } from './context.js';

// → docs/spec/11-mcp-tools.md

export const requestPermission: ToolFactory = ({ deps, agent, task }) => ({
  description:
    'Harness-internal. You do not call this — Claude Code invokes it through --permission-prompt-tool ' +
    'when one of your tool calls is not covered by the operator allow-list, to ask the operator to ' +
    'allow or deny it. It blocks until they decide and returns the verdict.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string', description: 'The tool the permission is for.' },
      input: { type: 'object', description: 'The tool input awaiting approval.' },
      tool_use_id: { type: 'string', description: 'Claude Code’s id for this tool use.' },
    },
  },
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
