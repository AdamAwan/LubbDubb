import type { FastifyInstance } from 'fastify';
import type { McpUsagePayload } from '../../wire.js';
import { buildMcpInsights } from '../../mcpInsights.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES, RETIRED_TOOL_NAMES } from '../../mcp/names.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/mcp/usage',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.rateLimits.readRateLimits());
      const since = sinceOrEpoch(window.since);
      return {
        insights: buildMcpInsights({
          calls: store.mcpCalls.listMcpCallsSince(since),
          agents: store.agents.listAgents(),
          tasks: store.tasks.listTasks(),
          namedInPrompts: store.tasks.countTasksNamingTools(since, [
            ...MCP_TOOL_NAMES,
            ...DESKTOP_TOOL_NAMES,
            ...RETIRED_TOOL_NAMES,
          ]),
          lastCallByTool: store.mcpCalls.lastMcpCallByTool(),
          callsEverByAgent: store.mcpCalls.countMcpCallsByAgent(),
          claudeArgs: system.config.claudeArgs,
          window,
          now,
        }),
      } satisfies McpUsagePayload;
    }),
  );
}
