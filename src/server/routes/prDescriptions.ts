import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueOriginRef } from '../../issueOrigins.js';
import { buildDescriptionAggregate } from '../../insights/descriptionAggregate.js';
import { descriptionRefusal } from '../../pr/prDescription.js';
import { checked, IssueNumberParams, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const PartParams = IssueNumberParams.extend({
  slug: requiredText('slug is required — a description belongs to a part, because a part is a pull request'),
});

const DescriptionBody = z.object({
  text: requiredText('text is required — a description version is what you say the pull request does'),
});

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  if (!system.config.manualDescriptions) return;
  const { store, config } = system;

  app.post(
    '/api/goals/:number/parts/:slug/description',
    checked({ params: PartParams, body: DescriptionBody }, async ({ params, body, reply }) => {
      const refusal = descriptionRefusal(body.text);
      if (refusal !== null) return reply.code(400).send({ error: refusal });
      const originRef = issueOriginRef('part', params.number, params.slug);
      const version = store.prDescriptions.appendDescription({
        originRef,
        text: body.text.trim(),
        author: config.userId ?? null,
      });
      hub.broadcast({ type: 'dirty', sections: ['plans'] });
      return { ok: true, version };
    }),
  );

  app.get(
    '/api/goals/:number/parts/:slug/description',
    checked({ params: PartParams }, async ({ params }) => {
      const originRef = issueOriginRef('part', params.number, params.slug);
      const versions = store.prDescriptions.listDescriptionVersions(originRef);
      return {
        current: versions.length === 0 ? null : versions[versions.length - 1],
        versions,
      };
    }),
  );

  /* One read for the goal, because the plan draws every part and the page badges
     each with whether it has been described. A panel per part would be five reads
     and five panels; the board is where the parts are told apart, so it is where
     the badge belongs. → docs/spec/17-cockpit.md#the-description-a-reviewer-reads */
  app.get(
    '/api/goals/:number/descriptions',
    checked({ params: IssueNumberParams }, async ({ params }) => ({
      parts: store.prDescriptions.goalDescriptions(params.number),
    })),
  );

  // Beside the prediction figures, and under their two rules: never keyed by author,
  // and never a bare percentage below the threshold that makes one mean anything.
  // → docs/spec/18-observability.md#how-a-description-stood
  app.get('/api/insights/descriptions', async () => ({
    aggregate: buildDescriptionAggregate(
      store.prDescriptions.listCheckedDescriptions(),
      config.predictionAggregateMinGoals,
    ),
  }));
}
