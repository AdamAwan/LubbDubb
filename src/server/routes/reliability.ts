import type { FastifyInstance } from 'fastify';
import type { ReliabilityPayload } from '../../wire.js';
import { buildReliabilityInsights } from '../../reliabilityInsights.js';
import { buildRemedyInsights, isReturnOrigin } from '../../remedyInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/reliability',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.rateLimits.readRateLimits());
      const since = sinceOrEpoch(window.since);
      const tasks = store.tasks.listTasks();
      const usageEvents = store.agents.listUsageEventsSince(since);
      return {
        insights: buildReliabilityInsights({
          agents: store.agents.listAgents(),
          tasks,
          ciEvents: store.world.listWorldEventsOfKindsSince(since, ['pr_ci']),
          usageEvents,
          window,
          now,
        }),
        remedies: buildRemedyInsights({
          remedies: store.remedies.listRemediesSince(since),
          returnDispatches: tasks.filter((t) => t.createdAt >= since && isReturnOrigin(t.originRef)).map((t) => t.id),
          usageEvents,
        }),
      } satisfies ReliabilityPayload;
    }),
  );
}
