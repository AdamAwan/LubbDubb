import type { FastifyInstance } from 'fastify';
import { issueOriginRef } from '../../issueOrigins.js';
import type { FeatureBoardPayload } from '../../wire.js';
import { allGoalReach } from '../../environments/reach.js';
import { buildFeatureBoard, featureBoardOn } from '../../features/featureBoard.js';
import { buildSpendGoals } from '../../spendInsights.js';
import { featureRecords } from '../../summaries/featureRecord.js';
import { ticketOutcomes } from '../../tickets/outcomes.js';
import { watchLabelFor } from '../../watchLabels.js';
import { checked, requiredBoolean } from '../validation.js';
import { NumberParams, SequenceAnswerBody } from '../../sequence/answer.js';
import { z } from 'zod';
import { goalPauseOrigin } from '../../goalPause.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, config } = system;

  const FEATURES_RATE_LIMIT = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };

  app.get(
    '/api/features',
    FEATURES_RATE_LIMIT,
    checked({}, async ({ reply }) => {
      if (!featureBoardOn(config, connector)) {
        return reply.code(404).send({ error: 'no feature board on this deployment' });
      }

      const runs = store.floor.listIssueRuns();
      const { goals } = buildSpendGoals({
        agents: store.agents.listAgents(),
        localRuns: store.localRuns.listLocalRuns(),
        tasks: store.tasks.listTasks(),
        nodes: store.graph.listWorkNodes(),
        issues: store.world.getWorldBaseline()?.issues ?? [],
        runs,
      });
      const deliveries = store.verdicts.listDeliveries();
      const shortfalls = store.verdicts.listShortfalls();
      const items = store.tickets.listTrackerItems();
      const featureSlots = store.tickets.ensureFeatureColors(items.flatMap((i) => (i.parent ? [i.parent.number] : [])));

      const standingKeys = new Map(
        featureRecords(store, {
          containerTypes: config.issueContainerTypes,
          watchLabel: watchLabelFor(config.labelPrefix),
          environments: config.environments,
        }).map((f) => [f.number, f.key]),
      );

      const board = buildFeatureBoard({
        items,
        standingKeys,
        outcomes: ticketOutcomes({
          runs,
          conclusions: store.verdicts.listIssueConclusions(),
          deliveries,
          shortfalls,
          plans: store.plans.listPlans(),
          planParts: store.plans.listAllPlanParts(),
        }),
        deliveries,
        shortfalls,
        summaries: new Map(store.tickets.listFeatureSummaries().map((f) => [f.originRef, f])),
        sequences: new Map(store.sequences.listFeatureSequences().map((s) => [s.originRef, s])),
        escalations: store.escalations.listEscalations(),
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        featureSlots,
        running: new Map(
          runs.filter((r) => r.completedAt === null && r.dismissedAt === null).map((r) => [r.issueNumber, r.startedAt]),
        ),
        reach: allGoalReach({
          landings: store.environments.listGoalLandings(),
          readings: store.environments.listEnvironmentReach(),
          nodes: store.graph.listWorkNodes(),
          landed: store.environments.landedPrs(),
          plans: store.plans.listPlans(),
          parts: store.plans.listAllPlanParts(),
          environments: config.environments,
        }),
        landings: store.environments.listGoalLandings(),
        environments: config.environments.map((e) => e.name),
        containerTypes: config.issueContainerTypes,
        watchLabel: watchLabelFor(config.labelPrefix),
        pauses: new Map(store.pauses.listGoalPauses().map((p) => [p.originRef, p])),
      });

      const refUrls: Record<string, string> = {};
      const refs = [
        ...board.features.map((f) => f.number),
        ...board.features.flatMap((f) => f.children.map((c) => c.number)),
        ...(board.orphans?.children ?? []).map((c) => c.number),
      ];
      for (const number of refs) {
        const url = connector.resolveRefUrl(issueOriginRef('root', number));
        if (url) refUrls[issueOriginRef('root', number)] = url;
      }

      return {
        ...board,
        backfilling: system.tickets.backfilling,
        refUrls,
      } satisfies FeatureBoardPayload;
    }),
  );

  app.post(
    '/api/features/:number/sequence',
    FEATURES_RATE_LIMIT,
    checked({ params: NumberParams, body: SequenceAnswerBody }, async ({ params, body, reply }) => {
      if (!featureBoardOn(config, connector)) {
        return reply.code(404).send({ error: 'no feature board on this deployment' });
      }
      const answered = store.sequences.answerFeatureSequence(
        issueOriginRef('root', params.number),
        body.answer,
        body.by,
      );
      if (!answered) {
        return reply
          .code(404)
          .send({ error: `feature #${params.number} has no order to answer — it may have been re-proposed` });
      }
      return answered;
    }),
  );

  const PauseBody = z.object({ paused: requiredBoolean('paused must be a boolean') });
  app.post(
    '/api/features/:number/pause',
    FEATURES_RATE_LIMIT,
    checked({ params: NumberParams, body: PauseBody }, ({ params, body, reply }) => {
      if (!featureBoardOn(config, connector)) {
        return reply.code(404).send({ error: 'no feature board on this deployment' });
      }
      store.pauses.setGoalPause(goalPauseOrigin(params.number), body.paused);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, paused: body.paused };
    }),
  );
}
