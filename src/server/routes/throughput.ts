import type { FastifyInstance } from 'fastify';
import type { ThroughputPayload } from '../../wire.js';
import { buildThroughputInsights, THROUGHPUT_EVENT_KINDS } from '../../throughputInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/throughput',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(window.since);
      return {
        insights: buildThroughputInsights({
          events: store.listWorldEventsOfKindsSince(since, THROUGHPUT_EVENT_KINDS),
          replies: store.listPrRepliesSentSince(since),
          window,
          now,
        }),
      } satisfies ThroughputPayload;
    }),
  );
}
