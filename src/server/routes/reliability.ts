import type { FastifyInstance } from 'fastify';
import type { ReliabilityPayload } from '../../wire.js';
import { buildReliabilityInsights, reliabilityWindowSince } from '../../reliabilityInsights.js';
import { buildRemedyInsights } from '../../remedyInsights.js';
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
        now,
      }),
      // The same `since` and the same usage events as the fold above, for the
      // reason both windows are resolved here rather than inside either fold: two
      // halves of one panel describing two different fortnights is a disagreement
      // no reader can see and neither fold can catch.
      remedies: buildRemedyInsights({
        remedies: store.listRemediesSince(since),
        returnDispatches: tasks.filter((t) => t.createdAt >= since && isReturnOrigin(t.originRef)).length,
        usageEvents,
      }),
    } satisfies ReliabilityPayload;
  });
}

/**
 * Whether a task was dispatched to answer a red or a review — the denominator
 * behind the Causes reading's `unaccounted`.
 *
 * Read off the **origin** rather than off `Task.rule`, because the origin is what
 * `remedyOrigin` fences the tool on: counting by rule would make the denominator
 * and the numerator two different populations, and the gap between them would
 * read as agents failing to report when it was the two definitions disagreeing.
 */
function isReturnOrigin(originRef: string | null): boolean {
  return originRef !== null && /^pr:\d+:(ci|comments)$/.test(originRef);
}
