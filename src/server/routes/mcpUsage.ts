import type { FastifyInstance } from 'fastify';
import type { McpUsagePayload } from '../../wire.js';
import { buildMcpInsights } from '../../mcpInsights.js';
import { DESKTOP_TOOL_NAMES, MCP_TOOL_NAMES, RETIRED_TOOL_NAMES } from '../../mcp/names.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The tool channel as a reading, behind the Insights MCP tab.
 *
 * A route of its own rather than a field on `/api/spend`, for the trend's reason:
 * the naming evidence is a scan of every dispatch prompt inside the window, which
 * is the one query in the harness that reads the `tasks.prompt` column in bulk —
 * 17 MB of it on a deployment with a year of history. An operator who opened
 * Insights to read the phase table should not pay for it, so the tab fetches on
 * its own first visit.
 *
 * **The window is the page's, and every read takes its `since`** — the rule the
 * other two insights routes keep, and it matters here in a way it does not there:
 * a silence is a count of zero measured against a stretch of time, so a tool
 * reading and a run count taken over different stretches would not merely
 * disagree, they would manufacture findings.
 *
 * The one thing on the payload that is **not** windowed is
 * `lastMcpCallByTool`, and deliberately: the most useful sentence about a silent
 * tool is "nothing called it this week, and the last call was nineteen days ago",
 * which is a date the window by definition cannot contain.
 *
 * → [16](../../../docs/spec/16-http-api.md), [11](../../../docs/spec/11-mcp-tools.md#what-is-recorded)
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/mcp/usage',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now);
      const since = sinceOrEpoch(window.since);
      return {
        insights: buildMcpInsights({
          calls: store.listMcpCallsSince(since),
          // Every agent, windowed in the fold on `runInstant` exactly as the spend
          // and reliability walks do — the runs are the denominator a silence is
          // measured against, so they must be the same set those two count.
          agents: store.listAgents(),
          // Summaries, not prompts: the prompts are asked about below, in SQL,
          // rather than loaded. See `countTasksNamingTools`.
          tasks: store.listTasks(),
          // Both live sets and the retired names, because "nothing named it" has
          // to be asked of the retired ones too — a prompt override still naming
          // one is the reading that finds it.
          namedInPrompts: store.countTasksNamingTools(since, [
            ...MCP_TOOL_NAMES,
            ...DESKTOP_TOOL_NAMES,
            ...RETIRED_TOOL_NAMES,
          ]),
          lastCallByTool: store.lastMcpCallByTool(),
          // Unwindowed, and the second read on this payload that is. A run alive
          // at the instant the window opened made its calls before it; asked the
          // windowed question it reads as a run that never reached the channel,
          // which is the tab's loudest alarm firing on a healthy agent.
          callsEverByAgent: store.countMcpCallsByAgent(),
          // A live config read rather than a fold, and the only one on this
          // payload: an operator `--allowedTools` in `claudeArgs` is the commonest
          // cause of a run that calls nothing, and it is worth reporting before
          // the first silent run rather than after it.
          claudeArgs: system.config.claudeArgs,
          window,
          now,
        }),
      } satisfies McpUsagePayload;
    }),
  );
}
