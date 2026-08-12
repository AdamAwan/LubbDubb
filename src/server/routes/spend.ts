import type { FastifyInstance } from 'fastify';
import type { SpendPayload } from '../../wire.js';
import { buildSpendInsights, spendTimelineSince } from '../../spendInsights.js';
import type { RouteContext } from './context.js';

/**
 * The spend breakdown behind the cost indicators.
 *
 * Fetched on open rather than shipped on `/api/state`, for the work graph's
 * reason: this walks every agent the harness has ever run and every dated cost
 * delta of the last fortnight, and the snapshot comes round every couple of
 * seconds for every open cockpit. What the indicators need to *draw* — the rolling
 * windows, and each goal's own total — is already on the snapshot and costs
 * nothing; this is the reading an operator goes looking for.
 *
 * Derived on the server rather than in the browser, and not only because the
 * timeline needs the store. The per-goal totals here are the ones the cards
 * already show, taken from `rollUpIssueSpend` whole: a cockpit-side re-derivation
 * would be a second opinion about which goal a pull request's money belongs to,
 * drawn inches from the first.
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get('/api/spend', async () => {
    const now = Date.now();
    const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
    return {
      insights: buildSpendInsights({
        agents: store.listAgents(),
        tasks: store.listTasks(),
        nodes: store.listWorkNodes(),
        // Titles only, and a goal missing from the baseline still gets its row —
        // the money was spent whether or not the world still lists the ticket.
        issues: store.getWorldBaseline()?.issues ?? [],
        usageEvents: store.listUsageEventsSince(spendTimelineSince(now)),
        // The same two sums `buildUsage` puts on the snapshot, asked the same way,
        // so the panel and the chip an operator opened it from state one figure.
        fiveHourCostUsd: store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
        sevenDayCostUsd: store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
        now,
      }),
    } satisfies SpendPayload;
  });
}
