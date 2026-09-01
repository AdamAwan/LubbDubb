import type { FastifyInstance } from 'fastify';
import type { SpendPayload, SpendTrendPayload } from '../../wire.js';
import { buildSpendGoals, buildSpendInsights } from '../../spendInsights.js';
import { buildSpendTrend } from '../../spendTrend.js';
import { InsightsQuery, resolveWindow, sinceOrEpoch, trendSince } from '../../insightsWindow.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The spend breakdown behind the Insights page's Economics and Work mix tabs.
 *
 * Fetched on open rather than shipped on `/api/state`, for the work graph's
 * reason: this walks every agent the harness has ever run and every dated cost
 * delta inside the window, and the snapshot comes round every couple of seconds
 * for every open cockpit. This is the reading an operator goes looking for.
 *
 * Derived on the server rather than in the browser, and not only because the
 * timeline needs the store. The per-goal totals here are the ones the cards
 * already show, taken from `rollUpIssueSpend` whole: a cockpit-side re-derivation
 * would be a second opinion about which goal a pull request's money belongs to,
 * drawn inches from the first.
 *
 * **The window is a parameter, and every store read takes its `since`.** The two
 * used to be one constant apiece and they disagreed across the three routes;
 * resolving it once and passing the resolution down is what makes "the whole
 * page is about the last 24 hours" a fact rather than an intention.
 * → [18](../../../docs/spec/18-observability.md#the-window)
 */
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
          // The fleet is not the only thing spending: a local run is a session on
          // the same account, and leaving it out here would put the page's total
          // below the money the goal cards already carry.
          localRuns: store.listLocalRuns(),
          tasks: store.listTasks(),
          nodes: store.listWorkNodes(),
          // Titles only, and a goal missing from the baseline still gets its row —
          // the money was spent whether or not the world still lists the ticket. The
          // run records name those rows: the tracker's open set forgets a goal the
          // moment it closes, and the harness's own record of what it worked does not.
          issues: store.getWorldBaseline()?.issues ?? [],
          runs: store.listIssueRuns(),
          // Every source of dated cost, not the agents' alone: a timeline drawn off
          // half of them would fall short of the total above it by exactly the local
          // runs, and nothing on the glass would say which half was missing.
          costDeltas: store.listCostDeltasSince(since),
          // The fleet's own output, over the same window as the money — which is
          // the pairing the production graph could never make, being a browser-side
          // count over a six-hour window nothing else shared.
          mergeEvents: store.listWorldEventsOfKindsSince(since, ['pr_merged']),
          window,
          now,
        }),
      } satisfies SpendPayload;
    }),
  );

  /**
   * The Trend tab, fetched on its *first visit* rather than with the breakdown.
   *
   * A route of its own for the reason the settings modal mounts its tabs lazily:
   * this reaches **eight windows** of world events and the closed end of the
   * ticket mirror on top of the same all-time agent walk, and an operator who
   * opened the page to read the phase table should not pay for it.
   *
   * Eight windows rather than one is the whole of what makes the tab obey the
   * same control as the rest of the page ({@link trendSince}) — and it is why
   * this route resolves its own `since` through that function rather than the
   * window's own, which would fetch a single period and draw seven empty bars.
   *
   * The goals are `buildSpendGoals`' own rows, which is the same fold the
   * breakdown ships — the two tabs state one goal's cost a click apart, and
   * agreement by construction is the only kind that holds.
   */
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
          window,
          now,
        }),
      } satisfies SpendTrendPayload;
    }),
  );
}
