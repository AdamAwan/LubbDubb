import { toolJson } from '../protocol.js';
import type { ToolFactory } from './context.js';

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
  // Returns the BARE `{behavior,…}` verdict `--permission-prompt-tool` expects,
  // through `toolJson` directly — never `ok()` (its `_status` envelope would
  // break Claude's permission parser) and never `toolError` (Claude reads an
  // error as a tool *failure*, not a structured deny). This is the one tool in
  // the set that never touches `ctx.ok`, which is why it is worth saying here.
  handler: async (args) => {
    if (!deps.permissions) {
      // Backstop off: deny rather than block. Claude sees a normal deny and the
      // agent carries on / escalates, exactly as with `mcp.permissionEscalation: false`.
      return toolJson({ behavior: 'deny', message: 'The permission backstop is disabled.' });
    }
    const toolName = typeof args.tool_name === 'string' && args.tool_name ? args.tool_name : 'a tool';
    const input = typeof args.input === 'object' && args.input !== null ? (args.input as Record<string, unknown>) : {};
    // Structural identity: like every write tool, the agent is the credential's,
    // never an argument. The tool/input come from Claude's permission machinery.
    const verdict = await deps.permissions.request(agent, task, toolName, input);
    return toolJson(verdict);
  },
});
