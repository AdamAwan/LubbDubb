import type { FastifyInstance } from 'fastify';
import type { FeatureBoardPayload } from '../../wire.js';
import { allGoalReach } from '../../environments/reach.js';
import { buildFeatureBoard } from '../../features/featureBoard.js';
import { buildSpendGoals } from '../../spendInsights.js';
import { ticketOutcomes } from '../../tickets/outcomes.js';
import { watchLabelFor } from '../../watchLabels.js';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The feature board: the fleet's work one tier up, per Feature rather than per
 * story (issue #—).
 *
 * **Fetched, never polled**, for `/api/tickets`' reason: it reads the whole mirror
 * on demand rather than on the cockpit's two-second poll, and the list is all-time.
 *
 * Every reading it ships is quoted rather than re-derived — the outcome word from
 * `ticketOutcomes`, the money from `buildSpendGoals`, the environment standing
 * from `allGoalReach`, the watch bucket from the label precedence the dispatcher's
 * own gate resolves through. It is a lens. Nothing here decides anything, and no
 * rule under `src/dispatcher/` reads it.
 *
 * ## Why the refusal is a 404 and not a 403
 *
 * The board is gated twice — on the operator's `featureBoard` flag and on the
 * provider being able to place a work item at all — and neither gate is about
 * permission. A deployment with the flag off, or pointed at GitHub, has no feature
 * board: the route does not exist there, which is what `404` says. A `403` would
 * say the operator may not see a page that is there, and would send whoever
 * reported it looking for a token problem.
 *
 * The same conjunction is shipped on `/api/state` as `config.featureBoard`, so the
 * cockpit draws no tab rather than a tab whose every fetch 404s. Both read the
 * same two predicates, in the same order, in one place — {@link featureBoardOn}.
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store, connector, config } = system;

  const FEATURES_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get(
    '/api/features',
    FEATURES_RATE_LIMIT,
    checked({}, async ({ reply }) => {
      if (!featureBoardOn(config, connector)) {
        return reply.code(404).send({ error: 'no feature board on this deployment' });
      }

      // Read once: the outcome words below and the spend goals beside them are two
      // readings of the same record.
      const runs = store.listIssueRuns();
      const { goals } = buildSpendGoals({
        agents: store.listAgents(),
        localRuns: store.listLocalRuns(),
        tasks: store.listTasks(),
        nodes: store.listWorkNodes(),
        issues: store.getWorldBaseline()?.issues ?? [],
        runs,
      });
      // Read once and quoted twice: `ticketOutcomes` folds these into its word and
      // the briefing carries the sentence their authors wrote. Two reads of the
      // same rows would let a card's word and its quotation disagree.
      const deliveries = store.listDeliveries();
      const shortfalls = store.listShortfalls();
      const items = store.listTrackerItems();
      // The same persisted ladder the Tickets tab's legend draws from, so a Feature
      // is the same colour on both surfaces. Assigned on being *drawn*, exactly as
      // the tickets route assigns it.
      const featureSlots = store.ensureFeatureColors(items.flatMap((i) => (i.parent ? [i.parent.number] : [])));

      const board = buildFeatureBoard({
        items,
        outcomes: ticketOutcomes({
          runs,
          conclusions: store.listIssueConclusions(),
          deliveries,
          shortfalls,
          plans: store.listPlans(),
          planParts: store.listAllPlanParts(),
        }),
        deliveries,
        shortfalls,
        // Every escalation; the briefing keeps the open ones that name a goal. The
        // filtering is the lens's, not the route's, for the reason every other
        // reading here is quoted rather than prepared.
        escalations: store.listEscalations(),
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        featureSlots,
        // A run the harness minted and has not finished, and that the operator has
        // not dismissed — the run row's own three-field reading of "still going",
        // not a second definition of it. → `docs/spec/03-world-model.md`
        running: new Map(
          runs.filter((r) => r.completedAt === null && r.dismissedAt === null).map((r) => [r.issueNumber, r.startedAt]),
        ),
        reach: allGoalReach({
          landings: store.listGoalLandings(),
          readings: store.listEnvironmentReach(),
          nodes: store.listWorkNodes(),
          landed: store.landedPrs(),
          plans: store.listPlans(),
          parts: store.listAllPlanParts(),
          environments: config.environments,
        }),
        landings: store.listGoalLandings(),
        environments: config.environments.map((e) => e.name),
        containerTypes: config.issueContainerTypes,
        watchLabel: watchLabelFor(config.labelPrefix),
      });

      // Resolved off the connector rather than read from the snapshot's map, for
      // the Tickets tab's reason: `refUrls` is built from the world, and most of
      // what this board draws left it long ago. The features and the rows actually
      // shipped, so the cost is the page rather than the mirror.
      const refUrls: Record<string, string> = {};
      const refs = [
        ...board.features.map((f) => f.number),
        ...board.features.flatMap((f) => f.children.map((c) => c.number)),
        ...(board.orphans?.children ?? []).map((c) => c.number),
      ];
      for (const number of refs) {
        const url = connector.resolveRefUrl(`issue:${number}`);
        if (url) refUrls[`issue:${number}`] = url;
      }

      return {
        ...board,
        // The tab's to *say*: an empty board mid-backfill looks exactly like a
        // tracker with no features in it.
        backfilling: system.tickets.backfilling,
        refUrls,
      } satisfies FeatureBoardPayload;
    }),
  );
}

/**
 * Whether this deployment has a feature board at all — the operator's flag **and**
 * the provider's hierarchy, in that order.
 *
 * One predicate, exported, because it is asked in two places that must never
 * disagree: this route's refusal and the `config.featureBoard` the cockpit draws
 * its tab off. Two copies would drift into the cockpit's worst shape — a tab whose
 * every fetch 404s, or a route nothing can reach.
 *
 * The provider half is `canPlaceWorkItem`, asked of the connector and never
 * inferred from its name, for `canCloseIssue`'s reason: the one place that decides
 * is the one the route asks. It is the right predicate rather than a near one —
 * placing a work item *is* setting its parent, so a provider that can do it is
 * exactly a provider with the container hierarchy this board rolls up, and GitHub
 * answers false by design. → `src/sink/actionSink.ts`
 */
export function featureBoardOn(config: { featureBoard: boolean }, connector: { canPlaceWorkItem(): boolean }): boolean {
  return config.featureBoard && connector.canPlaceWorkItem();
}
