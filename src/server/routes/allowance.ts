import type { FastifyInstance } from 'fastify';
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

/**
 * How far back the burn-down's readings are fetched, whatever window the page is
 * on.
 *
 * The projection is always about the **seven-day** allowance — an operator
 * reading the five-hour session still needs to know whether the week reaches its
 * reset — so its readings can never come from the page's own window. A little
 * over the fit stretch, so a fit that starts at a reset has history in front of
 * it rather than beginning at whatever the fetch happened to cut.
 */
const PROJECTION_LOOKBACK_MS = 3 * 24 * 3_600_000;

/**
 * The Allowance tab: the account's usage percentage over time, and the work that
 * spent it.
 *
 * A route of its own rather than a field on `SpendPayload`, for the trend tab's
 * reason: it walks the readings history on top of the same all-time agent walk,
 * and an operator who opened Insights to read the phase table should not pay for
 * it. Fetched on the tab's first visit for a given window.
 *
 * **The goals come from `buildSpendGoals`, never a second roll-up.** The
 * apportionment is a percentage laid over the same money the Economics tab
 * prices, and a cockpit that stated one goal's cost differently a click apart
 * would be two answers to one question — agreement by construction is the only
 * kind that holds. → [18](../../../docs/spec/18-observability.md#the-allowance)
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/allowance',
    checked({ query: InsightsQuery }, async ({ query }) => {
      const now = Date.now();
      const window = resolveWindow(query.window, now, store.readRateLimits());
      const since = sinceOrEpoch(window.since);
      const world = store.getWorldBaseline();
      // The window is applied once, here, exactly as `buildSpendInsights` applies
      // it — the lanes, the goals and the interval split all have to describe one
      // stretch, and a fold that cut its own would be a timeline whose bars sat
      // outside the axis they are drawn against.
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
      return {
        allowance: buildAllowanceInsights({
          readings,
          weekReadings: store.listRateLimitReadingsSince(new Date(now - PROJECTION_LOOKBACK_MS).toISOString()),
          // The agents' own deltas say **whose**, which is what an interval split
          // needs; the merged list is the interval's denominator, and the
          // difference between them is exactly the local runs.
          usageEvents: store.listUsageEventsSince(since),
          costDeltas: store.listCostDeltasSince(since),
          agents,
          tasks,
          nodes,
          goals: rollup.goals,
          attribution: rollup.attribution,
          mergeEvents: store.listWorldEventsOfKindsSince(since, ['pr_merged']),
          // The timeline is cut off the readings the fold actually holds, so an
          // `all` window describes the history this deployment has rather than
          // drawing empty buckets in front of it.
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
        }),
      } satisfies AllowancePayload;
    }),
  );
}
