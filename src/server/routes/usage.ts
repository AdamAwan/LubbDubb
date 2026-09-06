import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UsagePayload } from '../../wire.js';
import type { SurfaceReachInput } from '../../types.js';
import { buildOperatorInsights } from '../../operatorInsights.js';
import { buildSurfaceReach } from '../../surfaceReachInsights.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch } from '../../insightsWindow.js';
import { PLACE_KEYS, USAGE_SUBJECTS, VERBS_BY_SUBJECT } from '../../usage/events.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/usage',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(window.since);
      const plans = store.listPlans();
      return {
        insights: buildOperatorInsights({
          escalations: store.listEscalations(),
          proposals: store.listProposals(),
          humanTasks: store.listHumanTasks(ALL),
          obstacles: store.listObstacles(),
          upgrade: store.readUpgradeIntent(),
          landings: store.listStackLandings(ALL),
          plans,
          amendments: plans.flatMap((plan) => store.listPlanAmendments(plan.id)),
          checks: store.listAllValidationChecks(),
          conclusions: store.listIssueConclusions(),
          agents: store.listAgents(),
          costEvents: store.listUsageEventsSince(since),
          window,
          now,
        }),
        reach: buildSurfaceReach({
          rows: store.listSurfaceReachSince(since),
          everLinked: store.linkedSubjectsEverReached(),
          window,
        }),
      } satisfies UsagePayload;
    }),
  );

  app.post(
    '/api/usage/events',
    checked({ body: UsageBatchBody }, async ({ body }) => {
      store.recordSurfaceReach(body.events as SurfaceReachInput[]);
      store.pruneSurfaceReach();
      return { ok: true };
    }),
  );
}

const ALL = 100_000;

const BATCH_MAX = 500;

const UsageEventRow = z
  .object({
    subject: z.enum(USAGE_SUBJECTS as [string, ...string[]], {
      errorMap: () => ({ message: 'subject must be one of the registry’s subjects' }),
    }),
    verb: z.string({ required_error: 'verb must be one the subject offers' }),
    place: z.enum(PLACE_KEYS as unknown as [string, ...string[]], {
      errorMap: () => ({ message: `place must be one of ${PLACE_KEYS.join(', ')}` }),
    }),
    arrival: z.enum(['linked', 'direct'], { errorMap: () => ({ message: 'arrival must be linked or direct' }) }),
  })
  .refine(
    (row) => (VERBS_BY_SUBJECT[row.subject as keyof typeof VERBS_BY_SUBJECT] as readonly string[]).includes(row.verb),
    {
      message: 'verb must be one the subject offers',
    },
  );

const UsageBatchBody = z.object({
  events: z
    .array(UsageEventRow, { required_error: 'events must be an array of usage rows' })
    .max(BATCH_MAX, { message: `events must hold at most ${BATCH_MAX} rows` }),
});
