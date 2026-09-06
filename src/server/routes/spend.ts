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
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(window.since);
      return {
        insights: buildSpendInsights({
          agents: store.listAgents(),
          localRuns: store.listLocalRuns(),
          tasks: store.listTasks(),
          nodes: store.listWorkNodes(),
          issues: store.getWorldBaseline()?.issues ?? [],
          runs: store.listIssueRuns(),
          costDeltas: store.listCostDeltasSince(since),
          mergeEvents: store.listWorldEventsOfKindsSince(since, ['pr_merged']),
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
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(trendSince(window));
      const world = store.getWorldBaseline();
      const agents = store.listAgents();
      return {
        trend: buildSpendTrend({
          goals: buildSpendGoals({
            agents,
            localRuns: store.listLocalRuns(),
            tasks: store.listTasks(),
            nodes: store.listWorkNodes(),
            issues: world?.issues ?? [],
            runs: store.listIssueRuns(),
          }).goals,
          closures: store.listTicketsClosedSince(since),
          issues: world?.issues ?? [],
          agents,
          ciEvents: store.listWorldEventsOfKindsSince(since, ['pr_ci']),
          window,
          now,
        }),
      } satisfies SpendTrendPayload;
    }),
  );
}
