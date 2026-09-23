import type { FastifyInstance } from 'fastify';
import type { ApiErrorsPayload } from '../../wire.js';
import { buildApiErrorInsights } from '../../insights/apiErrorInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insights/insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/api-errors',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const window = resolveWindow(query.window, Date.now(), store.rateLimits.readRateLimits());
      return {
        insights: buildApiErrorInsights({
          errors: store.apiErrors.listApiErrorsSince(sinceOrEpoch(window.since)),
          agents: store.agents.listAgents(),
          since: window.since,
        }),
      } satisfies ApiErrorsPayload;
    }),
  );
}
