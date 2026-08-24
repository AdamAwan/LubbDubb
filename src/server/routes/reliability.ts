import type { FastifyInstance } from 'fastify';
import type { ReliabilityPayload } from '../../wire.js';
import { buildReliabilityInsights } from '../../reliabilityInsights.js';
import { buildRemedyInsights, isReturnOrigin } from '../../remedyInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * Did the work finish, and did it go green — the Insights page's Reliability and
 * Causes tabs.
 *
 * Fetched on open for `/api/spend`'s reason and with the same shape of cost: it
 * walks every agent the harness has ever run, plus the window's CI transitions,
 * and the snapshot comes round every couple of seconds for every open cockpit.
 * Nothing here is needed to draw anything on the top bar.
 *
 * The window is asked for **once** here and passed down, so the `since` a row is
 * selected by and the `since` it is bucketed into are one value. A store read
 * wider than the buckets would drop rows silently at the fold; a narrower one
 * would draw an empty first bucket that was never empty.
 *
 * It is also the same window the spend route resolved, because the page asks
 * both with the same key: the completion rate on one tab and the phase costs on
 * another are now about the same stretch of the fleet's life, which they were
 * not when one fold was all-time and the other a fortnight.
 * → [18](../../../docs/spec/18-observability.md#the-window)
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/reliability',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now);
      const since = sinceOrEpoch(window.since);
      const tasks = store.listTasks();
      const usageEvents = store.listUsageEventsSince(since);
      return {
        insights: buildReliabilityInsights({
          agents: store.listAgents(),
          tasks,
          // Oldest first, and that ordering is load-bearing: the fold reads each
          // pull request's transitions in the order they happened.
          ciEvents: store.listWorldEventsOfKindsSince(since, ['pr_ci']),
          usageEvents,
          window,
          now,
        }),
        // The same `since` and the same usage events as the fold above, for the
        // reason the window is resolved here rather than inside either fold: two
        // halves of one page describing two different stretches is a disagreement
        // no reader can see and neither fold can catch.
        remedies: buildRemedyInsights({
          remedies: store.listRemediesSince(since),
          returnDispatches: tasks.filter((t) => t.createdAt >= since && isReturnOrigin(t.originRef)).map((t) => t.id),
          usageEvents,
        }),
      } satisfies ReliabilityPayload;
    }),
  );
}
