import type { FastifyInstance } from 'fastify';
import { issueOriginRef } from '../../issueOrigins.js';
import type { AllowancePayload } from '../../wire.js';
import { buildAllowanceInsights } from '../../allowanceInsights.js';
import { buildSpendGoals } from '../../spendInsights.js';
import {
  InsightsQuery,
  resolveWindow,
  runInWindow,
  sinceOrEpoch,
  timelineSpan,
  windowView,
} from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const PROJECTION_LOOKBACK_MS = 3 * 24 * 3_600_000;

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, connector } = system;

  app.get(
    '/api/allowance',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(window.since);
      const world = store.getWorldBaseline();
      const agents = store.listAgents().filter((agent) => runInWindow(window, agent));
      const localRuns = store.listLocalRuns().filter((run) => runInWindow(window, run));
      const tasks = store.listTasks();
      const nodes = store.listWorkNodes();
      const rollup = buildSpendGoals({
        agents,
        localRuns,
        tasks,
        nodes,
        issues: world?.issues ?? [],
        runs: store.listIssueRuns(),
      });
      const readings = store.listRateLimitReadingsSince(since);
      const allowance = buildAllowanceInsights({
        readings,
        weekReadings: store.listRateLimitReadingsSince(new Date(now - PROJECTION_LOOKBACK_MS).toISOString()),
        usageEvents: store.listUsageEventsSince(since),
        costDeltas: store.listCostDeltasSince(since),
        agents,
        tasks,
        nodes,
        goals: rollup.goals,
        attribution: rollup.attribution,
        mergeEvents: store.listWorldEventsOfKindsSince(since, ['pr_merged']),
        window: windowView(
          window,
          timelineSpan(
            window,
            readings.reduce<number | null>((oldest, reading) => {
              const at = Date.parse(reading.capturedAt);
              return Number.isNaN(at) ? oldest : oldest === null || at < oldest ? at : oldest;
            }, null),
          ),
        ),
        now,
      });

      const refUrls: Record<string, string> = {};
      for (const goal of allowance.apportionment.goals) {
        const url = connector.resolveRefUrl(goal.originRef);
        if (url) refUrls[goal.originRef] = url;
      }
      for (const lane of allowance.lanes) {
        if (lane.issueNumber === null) continue;
        const ref = issueOriginRef('root', lane.issueNumber);
        if (ref in refUrls) continue;
        const url = connector.resolveRefUrl(ref);
        if (url) refUrls[ref] = url;
      }

      return { allowance, refUrls } satisfies AllowancePayload;
    }),
  );
}
