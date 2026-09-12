import type { FastifyInstance } from 'fastify';
import type { SpendPayload, SpendTrendPayload } from '../../wire.js';
import { buildSpendGoals, buildSpendInsights } from '../../spendInsights.js';
import { buildSpendTrend } from '../../spendTrend.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch, trendSince } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/spend',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.rateLimits.readRateLimits());
      const since = sinceOrEpoch(window.since);
      return {
        insights: buildSpendInsights({
          agents: store.agents.listAgents(),
          localRuns: store.localRuns.listLocalRuns(),
          tasks: store.tasks.listTasks(),
          nodes: store.graph.listWorkNodes(),
          issues: store.world.getWorldBaseline()?.issues ?? [],
          runs: store.floor.listIssueRuns(),
          costDeltas: store.listCostDeltasSince(since),
          mergeEvents: store.world.listWorldEventsOfKindsSince(since, ['pr_merged']),
          window,
          now,
        }),
      } satisfies SpendPayload;
    }),
  );

  app.get(
    '/api/spend/trend',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.rateLimits.readRateLimits());
      const since = sinceOrEpoch(trendSince(window));
      const world = store.world.getWorldBaseline();
      const agents = store.agents.listAgents();
      return {
        trend: buildSpendTrend({
          goals: buildSpendGoals({
            agents,
            localRuns: store.localRuns.listLocalRuns(),
            tasks: store.tasks.listTasks(),
            nodes: store.graph.listWorkNodes(),
            issues: world?.issues ?? [],
            runs: store.floor.listIssueRuns(),
          }).goals,
          closures: store.tickets.listTicketsClosedSince(since),
          issues: world?.issues ?? [],
          agents,
          ciEvents: store.world.listWorldEventsOfKindsSince(since, ['pr_ci']),
          window,
          now,
        }),
      } satisfies SpendTrendPayload;
    }),
  );
}
