import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { criteriaAnchors, criteriaStanding } from '../../criteria/standing.js';
import { issueOriginRef } from '../../issueOrigins.js';
import type { GoalCriteriaVersion } from '../../types.js';
import { checked, IssueNumberParams, optionalText, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const CriteriaBody = z.object({
  text: requiredText('text is required — a criteria version is the text of what "done" means'),
  reason: optionalText('reason'),
});

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  if (!system.config.goalCriteria.enabled) return;
  const { store, config } = system;

  app.post(
    '/api/goals/:number/criteria',
    checked({ params: IssueNumberParams, body: CriteriaBody }, async ({ params, body, reply }) => {
      const originRef = issueOriginRef('root', params.number);
      const anchors = criteriaAnchors(system, originRef);
      // The refusal has to be decided before the write, because the chain is
      // append-only: there is no row to take back once a version without its reason
      // is in the table. The standing a version authored now would carry is the same
      // derivation every read uses, against the same anchors.
      const pending = criteriaStanding({ authoredAt: new Date().toISOString(), ...anchors });
      if (pending === 'post-work' && body.reason === undefined)
        return reply.code(400).send({
          error:
            'work has already been dispatched on this goal, so changing its criteria is drift — a reason is required',
        });
      const version = store.goalCriteria.appendCriteria({
        originRef,
        text: body.text,
        author: config.userId ?? null,
        reason: body.reason ?? null,
      });
      const standing = criteriaStanding({ authoredAt: version.authoredAt, ...anchors });
      if (standing === 'post-work')
        store.goalCriteria.recordDrift({
          originRef,
          criteriaId: version.id,
          version: version.version,
          author: version.author,
          reason: version.reason,
        });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      return { ok: true, version, standing };
    }),
  );

  app.get(
    '/api/goals/:number/criteria',
    checked({ params: IssueNumberParams }, async ({ params }) => {
      const originRef = issueOriginRef('root', params.number);
      const anchors = criteriaAnchors(system, originRef);
      const versions = store.goalCriteria.listCriteriaVersions(originRef).map((version) => withStanding(version));
      return {
        current: versions.length === 0 ? null : versions[versions.length - 1],
        versions,
      };

      function withStanding(version: GoalCriteriaVersion): GoalCriteriaVersion & { standing: string } {
        return { ...version, standing: criteriaStanding({ authoredAt: version.authoredAt, ...anchors }) };
      }
    }),
  );
}
