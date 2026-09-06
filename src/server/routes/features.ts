import type { FastifyInstance } from 'fastify';
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

      const runs = store.listIssueRuns();
      const { goals } = buildSpendGoals({
        agents: store.listAgents(),
        localRuns: store.listLocalRuns(),
        tasks: store.listTasks(),
        nodes: store.listWorkNodes(),
        issues: store.getWorldBaseline()?.issues ?? [],
        runs,
      });
      const deliveries = store.listDeliveries();
      const shortfalls = store.listShortfalls();
      const items = store.listTrackerItems();
      const featureSlots = store.ensureFeatureColors(items.flatMap((i) => (i.parent ? [i.parent.number] : [])));

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
          conclusions: store.listIssueConclusions(),
          deliveries,
          shortfalls,
          plans: store.listPlans(),
          planParts: store.listAllPlanParts(),
        }),
        deliveries,
        shortfalls,
        summaries: new Map(store.listFeatureSummaries().map((f) => [f.originRef, f])),
        sequences: new Map(store.listFeatureSequences().map((s) => [s.originRef, s])),
        escalations: store.listEscalations(),
        costs: new Map(goals.map((g) => [g.issueNumber, g.costUsd])),
        featureSlots,
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
        pauses: new Map(store.listGoalPauses().map((p) => [p.originRef, p])),
      });

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
      const answered = store.answerFeatureSequence(`issue:${params.number}`, body.answer, body.by);
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
      store.setGoalPause(goalPauseOrigin(params.number), body.paused);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, paused: body.paused };
    }),
  );
}
