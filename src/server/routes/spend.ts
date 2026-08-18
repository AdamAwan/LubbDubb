import type { FastifyInstance } from 'fastify';
import type { SpendPayload, SpendTrendPayload } from '../../wire.js';
import { buildSpendGoals, buildSpendInsights, spendTimelineSince } from '../../spendInsights.js';
import { buildSpendTrend, spendTrendSince } from '../../spendTrend.js';
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
        // the money was spent whether or not the world still lists the ticket. The
        // run records name those rows: the tracker's open set forgets a goal the
        // moment it closes, and the harness's own record of what it worked does not.
        issues: store.getWorldBaseline()?.issues ?? [],
        runs: store.listIssueRuns(),
        usageEvents: store.listUsageEventsSince(spendTimelineSince(now)),
        // The same two sums `buildUsage` puts on the snapshot, asked the same way,
        // so the panel and the chip an operator opened it from state one figure.
        fiveHourCostUsd: store.sumUsageCostSince(iso(5 * 60 * 60 * 1000)),
        sevenDayCostUsd: store.sumUsageCostSince(iso(7 * 24 * 60 * 60 * 1000)),
        now,
      }),
    } satisfies SpendPayload;
  });

  /**
   * The trend tab, fetched on its *first visit* rather than with the breakdown.
   *
   * A route of its own for the reason the settings modal mounts its tabs lazily:
   * this reaches two months of world events and the closed end of the ticket
   * mirror on top of the same all-time agent walk, and an operator who opened the panel to read the phase table should not
   * pay for it. Both tabs stay mounted once visited, so the cost is once per
   * panel session either way.
   *
   * The goals are `buildSpendGoals`' own rows, which is the same fold the
   * breakdown ships — the two tabs state one goal's cost a click apart, and
   * agreement by construction is the only kind that holds.
   */
  app.get('/api/spend/trend', async () => {
    const now = Date.now();
    const since = spendTrendSince(now);
    const world = store.getWorldBaseline();
    const agents = store.listAgents();
    return {
      trend: buildSpendTrend({
        goals: buildSpendGoals({
          agents,
          tasks: store.listTasks(),
          nodes: store.listWorkNodes(),
          issues: world?.issues ?? [],
          runs: store.listIssueRuns(),
        }).goals,
        // The ticket mirror, not `world_events`: `issue_closed` needs an in-place
        // open→closed transition and both real providers snapshot the open set
        // only, so the event never fires off one. The mirror's history read
        // returns closed items, so it is the only source that has any.
        closures: store.listTicketsClosedSince(since),
        // The world as it stands, for the reopen check: a goal that closed inside
        // the window and is open here came back.
        issues: world?.issues ?? [],
        agents,
        ciEvents: store.listWorldEventsOfKindsSince(since, ['pr_ci']),
        now,
      }),
    } satisfies SpendTrendPayload;
  });
}
