import type { FastifyInstance } from 'fastify';
import type { ReliabilityPayload } from '../../wire.js';
import type { LessonInsights } from '../../insights/lessonInsights.js';
import { buildReliabilityInsights } from '../../insights/reliabilityInsights.js';
import { buildRemedyInsights, isReturnOrigin } from '../../insights/remedyInsights.js';
import { buildReviewLabelInsights } from '../../insights/reviewLabelInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insights/insightsWindow.js';
import { readLessonInsights } from '../../lessons/lessonReading.js';
import { lessonLabelFor } from '../../watchLabels.js';
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
          window,
          now,
        }),
        remedies: buildRemedyInsights({
          remedies: store.remedies.listRemediesSince(since),
          returnDispatches: tasks.filter((t) => t.createdAt >= since && isReturnOrigin(t.originRef)).map((t) => t.id),
          usageEvents,
        }),
        reviewLabels: buildReviewLabelInsights({
          labels: store.prThreadLabels.listThreadLabelsSince(since),
          replies: store.prReplies.listPrRepliesSentSince(since),
          areas: system.config.reviewAreas,
          botAuthors: system.config.review.machineAuthors,
        }),
        lessons: lessonReading(system, now),
      } satisfies ReliabilityPayload;
    }),
  );
}

function lessonReading(system: RouteContext['system'], now: number): LessonInsights {
  const { store, config } = system;
  return readLessonInsights(store, store.lessons.listDrafts(), {
    reviewAreas: config.reviewAreas,
    lessonLabel: lessonLabelFor(config.labelPrefix),
    now,
  });
}
