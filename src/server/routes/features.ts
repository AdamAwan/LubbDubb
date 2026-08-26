import type { FastifyInstance } from 'fastify';
import type { FeatureNode, FeaturesPayload } from '../../wire.js';
import { buildFeatureTree } from '../../features/featureTree.js';
import { buildSpendGoals } from '../../spendInsights.js';
import { ticketOutcomes } from '../../tickets/outcomes.js';
import { watchLabelFor } from '../../watchLabels.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The Features page's tree: the tracker's hierarchy, with what the fleet has made
 * of each branch rolled up it.
 *
 * **Whole, never paged.** Every other list route this size is a keyset cursor, and
 * this one deliberately is not: a tree cut off part-way down reports a branch as
 * complete when the rest of it is on the next page, which is the one number the
 * page exists to state. The cost is the same one `/api/tickets` already pays and
 * for the same stated reason — a mirror row is one line with no body, the table is
 * bounded by the tracker's assigned backlog rather than by time, and the page is
 * fetched when it opens rather than on the cockpit's poll.
 *
 * Three readings are *quoted* rather than re-derived, the same three
 * `/api/tickets` quotes and for the same reason: money is `buildSpendGoals`'
 * answer, the outcome word is `ticketOutcomes`' and the watch bucket is
 * `src/watchLabels.ts`'. A lens. Nothing here decides anything, and no rule under
 * `src/dispatcher/` reads it. → docs/spec/17-cockpit.md#the-features-page
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, connector, config } = system;

  // Rate-limited for `/api/tickets`' reason: it reads the mirror and the baseline on
  // demand rather than on the cockpit's poll. The page fetches once on open, so the
  // ceiling is far above any real interaction.
  const FEATURES_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.get(
    '/api/features',
    FEATURES_RATE_LIMIT,
    checked({}, async () => {
      const runs = store.listIssueRuns();
      const baseline = store.getWorldBaseline();
      const issues = baseline?.issues ?? [];
      const { goals } = buildSpendGoals({
        agents: store.listAgents(),
        localRuns: store.listLocalRuns(),
        tasks: store.listTasks(),
        nodes: store.listWorkNodes(),
        issues,
        runs,
      });
      const items = store.listTrackerItems();
      // The same hues the tickets tab spends, from the same store: a feature that is
      // blue on one surface and green on the other is two answers to one question.
      const featureSlots = store.ensureFeatureColors(
        items.flatMap((item) => (item.parent ? [item.parent.number] : [])),
      );
      const tree = buildFeatureTree({
        items,
        issues,
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        outcomes: ticketOutcomes({
          runs,
          conclusions: store.listIssueConclusions(),
          deliveries: store.listDeliveries(),
          shortfalls: store.listShortfalls(),
          plans: store.listPlans(),
          planParts: store.listAllPlanParts(),
        }),
        featureSlots,
        watchLabel: watchLabelFor(config.labelPrefix),
        containerTypes: config.issueContainerTypes,
      });

      // Resolved off the connector rather than read from the snapshot's map, for
      // `/api/tickets`' reason: that map is built from the world, and a container the
      // filter never returned was never in it.
      const refUrls: Record<string, string> = {};
      const walk = (nodes: readonly FeatureNode[]): void => {
        for (const node of nodes) {
          const url = connector.resolveRefUrl(`issue:${node.number}`);
          if (url) refUrls[`issue:${node.number}`] = url;
          walk(node.children);
        }
      };
      walk([...tree.roots, ...tree.orphans]);

      return {
        ...tree,
        containerTypes: [...config.issueContainerTypes],
        refUrls,
      } satisfies FeaturesPayload;
    }),
  );
}
