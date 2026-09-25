import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { revealGateOn } from '../../config/config.js';
import { issueOriginRef } from '../../issueOrigins.js';
import { PREDICTION_SLOTS } from '../../store/predictions.js';
import { buildPredictionAggregate, predictionFacts } from '../../insights/predictionAggregate.js';
import type { PredictionAggregatePayload } from '../../wire.js';
import { checked, IssueNumberParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const PredictionBody = z.object({
  locus: optionalText('locus'),
  cause: optionalText('cause'),
  split: optionalText('split'),
  avoid: optionalText('avoid'),
});

const Mark = z.enum(['matched', 'missed', 'not-applicable']).nullable().optional();

const MarkBody = z.object({ locus: Mark, cause: Mark, split: Mark, avoid: Mark });

export function register(app: FastifyInstance, ctx: RouteContext): void {
  if (!revealGateOn(ctx.system.config)) return;
  registerPredictionRoute(app, ctx);
  registerRevealRoute(app, ctx);
  registerMarkRoutes(app, ctx);
  registerReadRoutes(app, ctx);
}

function registerPredictionRoute(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { predictions, config } = system;

  app.post(
    '/api/goals/:number/prediction',
    checked({ params: IssueNumberParams, body: PredictionBody }, async ({ params, body, reply }) => {
      const originRef = issueOriginRef('root', params.number);
      if (!PREDICTION_SLOTS.some((slot) => body[slot] !== undefined))
        return reply
          .code(400)
          .send({ error: 'a prediction needs at least one slot filled — every slot is skippable, but not all four' });
      if (predictions.getReveal(originRef) !== null)
        return reply
          .code(409)
          .send({ error: 'the plan for this goal has been revealed, and a prediction written after that is not one' });
      const prediction = predictions.recordPrediction({
        originRef,
        author: config.userId ?? null,
        slots: { locus: body.locus, cause: body.cause, split: body.split, avoid: body.avoid },
      });
      if (prediction === null)
        return reply.code(409).send({ error: 'a prediction is recorded once and is not re-openable' });
      hub.broadcast({ type: 'dirty', sections: ['plans'] });
      return { ok: true, prediction };
    }),
  );
}

function registerMarkRoutes(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, predictions } = system;

  // The two moments are two routes over the same slots, because they are two
  // records: moment one is a claim about the operator's model of the system and
  // moment two is a claim about the plan. Answering one says nothing about the
  // other, and either arriving alone must read as the other being unanswered.
  for (const [path, write] of [
    ['/api/goals/:number/prediction/marks', predictions.recordPlanMarks.bind(predictions)],
    ['/api/goals/:number/prediction/outcome', predictions.recordOutcomeMarks.bind(predictions)],
  ] as const) {
    app.post(
      path,
      checked({ params: IssueNumberParams, body: MarkBody }, async ({ params, body, reply }) => {
        const originRef = issueOriginRef('root', params.number);
        if (store.plans.getPlanByOrigin(originRef) === null)
          return reply
            .code(409)
            .send({ error: 'this goal has no plan yet, so there is nothing to mark the prediction against' });
        const outcome = write({
          originRef,
          marks: { locus: body.locus, cause: body.cause, split: body.split, avoid: body.avoid },
        });
        if (!outcome.ok) {
          if (outcome.reason === 'slot-skipped')
            return reply
              .code(409)
              .send({ error: `the ${outcome.slot} slot was skipped, so there is nothing there to mark` });
          if (outcome.reason === 'no-prediction')
            return reply.code(404).send({ error: 'there is no prediction on this goal to mark' });
          return reply
            .code(409)
            .send({ error: 'this goal has not been revealed, and a mark against an unseen plan is not a mark' });
        }
        hub.broadcast({ type: 'dirty', sections: ['plans'] });
        return { ok: true, prediction: outcome.prediction };
      }),
    );
  }
}

function registerRevealRoute(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, predictions, harness } = system;

  app.post(
    '/api/goals/:number/reveal',
    checked({ params: IssueNumberParams }, async ({ params, reply }) => {
      const originRef = issueOriginRef('root', params.number);
      const plan = store.plans.getPlanByOrigin(originRef);
      const standing = predictions.getReveal(originRef);
      // With no plan row the stamp closes the goal's intake sitting, which is what
      // releases its planner. With one, the goal is offered the gate once, when its
      // plan is ready: stamping a plan that is not awaiting approval would burn the
      // gate over a press that revealed nothing, and read as a decline rather than as
      // never offered.
      const sitting = plan === null;
      if (
        standing === null &&
        sitting &&
        store.world.getWorldBaseline()?.issues.some((i) => i.number === params.number && i.state === 'open') !== true
      )
        return reply
          .code(409)
          .send({ error: 'there is no open goal with this number, so there is no sitting to close' });
      if (standing === null && !sitting && plan.status !== 'awaiting_approval')
        return reply
          .code(409)
          .send({ error: 'there is no plan awaiting approval on this goal, so there is nothing to reveal' });
      const reveal = standing ?? predictions.recordReveal(originRef);
      if (standing === null && sitting) {
        const criteria = store.goalCriteria.currentCriteria(originRef);
        if (criteria !== null) store.goalCriteria.recordPressedOn(originRef, criteria.version);
      }
      if (standing === null) {
        hub.broadcast({ type: 'dirty', sections: ['plans'] });
        if (sitting) await harness.runCycle('manual');
      }
      return { ok: true, reveal, plan };
    }),
  );
}

function registerReadRoutes(app: FastifyInstance, { system }: RouteContext): void {
  const { store, predictions, config } = system;

  /**
   * The aggregate is its own read rather than a section on the state payload, on
   * the precedent every other insight here follows (`/api/spend`, `/api/throughput`):
   * it is a whole-history fold nobody needs on every pulse, and the state payload is
   * broadcast on each one. It is gated where the rest of this module is — the route
   * is not mounted at all with both keys off — and everything downstream reads the
   * presence of the data, never the flag.
   *
   * It is keyed by slot and by goal. There is no author parameter and no author in
   * what it returns, because scoring people is out of scope: `predictionFacts` drops
   * the author with the slot text on the way in, so the filter a later change would
   * reach for has nothing to group by.
   */
  app.get('/api/predictions/aggregate', async () => {
    const planned = [...new Set(store.plans.listPlans().map((plan) => plan.originRef))];
    return {
      aggregate: buildPredictionAggregate({
        facts: predictions.listPredictions().map(predictionFacts),
        reveals: predictions.listReveals(),
        plannedGoals: planned,
        drift: store.goalCriteria.listCriteriaDrift(),
        threshold: config.predictionAggregateMinGoals,
        now: Date.now(),
      }),
    } satisfies PredictionAggregatePayload;
  });

  app.get(
    '/api/goals/:number/prediction',
    checked({ params: IssueNumberParams }, async ({ params }) => {
      const originRef = issueOriginRef('root', params.number);
      return { prediction: predictions.getPrediction(originRef), reveal: predictions.getReveal(originRef) };
    }),
  );
}
