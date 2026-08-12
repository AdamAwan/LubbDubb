import type { FastifyInstance } from 'fastify';
import type { ReliabilityPayload } from '../../wire.js';
import { buildReliabilityInsights, reliabilityWindowSince } from '../../reliabilityInsights.js';
import type { RouteContext } from './context.js';

/**
 * Did the work finish, and did it go green — the reading beside the spend one.
 *
 * Fetched on open for `/api/spend`'s reason and with the same shape of cost: it
 * walks every agent the harness has ever run, plus a fortnight of CI transitions,
 * and the snapshot comes round every couple of seconds for every open cockpit.
 * Nothing here is needed to *draw* the gauge it opens from — the completion rate
 * on the face is derived from the agent rows the snapshot already carries.
 *
 * Both windows are asked for here rather than inside the fold, so the `since` a
 * row is selected by and the `since` it is bucketed into are one value. A store
 * read wider than the buckets would drop rows silently at the fold; a narrower
 * one would draw an empty first day that was never empty.
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get('/api/reliability', async () => {
    const now = Date.now();
    const since = reliabilityWindowSince(now);
    return {
      insights: buildReliabilityInsights({
        agents: store.listAgents(),
        tasks: store.listTasks(),
        // Oldest first, and that ordering is load-bearing: the fold reads each
        // pull request's transitions in the order they happened.
        ciEvents: store.listWorldEventsOfKindsSince(since, ['pr_ci']),
        usageEvents: store.listUsageEventsSince(since),
        now,
      }),
    } satisfies ReliabilityPayload;
  });
}
