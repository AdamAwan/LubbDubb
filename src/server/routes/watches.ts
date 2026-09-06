import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { watchWindowMs } from '../../environments/watchWindow.js';
import { issueOrigin } from '../../plans/planning.js';
import { WatchCheckSchema, watchCheckInput } from '../../validation/watchDocument.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  const ProposalParams = IssueNumberParams.extend({ checkId: z.string().min(1, 'checkId is required') });

  const RulingBody = z.object({
    accept: z.boolean({
      required_error: 'accept is required — true to run this check, false to decline it',
      invalid_type_error: 'accept is required — true to run this check, false to decline it',
    }),
  });

  app.put(
    '/api/issues/:number/watch/checks/:checkId',
    checked({ params: ProposalParams, body: WatchCheckSchema }, async ({ params, body, reply }) => {
      if (body.id !== params.checkId)
        return reply.code(400).send({ error: `the body declares "${body.id}" and the path names "${params.checkId}"` });
      const origin = issueOrigin(params.number);
      const check = store.saveOperatorWatch(origin, watchCheckInput(body, 0));
      hub.broadcast({ type: 'world:changed' });
      const dryRun = await system.watch.run(origin);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check, dryRun };
    }),
  );

  app.delete(
    '/api/issues/:number/watch/checks/:checkId',
    checked({ params: ProposalParams }, ({ params, reply }) => {
      const gone = store.deleteGoalWatch(issueOrigin(params.number), params.checkId);
      if (!gone) return reply.code(404).send({ error: 'no such check on that goal' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );

  app.post(
    '/api/issues/:number/watch-proposals/:checkId',
    checked({ params: ProposalParams, body: RulingBody }, async ({ params, body, reply }) => {
      const origin = issueOrigin(params.number);
      const ruled = store.ruleOnWatchProposal(origin, params.checkId, body.accept);
      if (ruled === null && body.accept)
        return reply.code(404).send({ error: 'no pending watch declaration on that check' });
      hub.broadcast({ type: 'world:changed' });
      const refusals = body.accept ? await system.watch.run(origin) : [];
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check: ruled, dryRun: refusals };
    }),
  );

  const ExtendParams = IssueNumberParams.extend({ environment: z.string().min(1, 'environment is required') });

  app.post(
    '/api/issues/:number/watch/:environment/extend',
    checked({ params: ExtendParams }, ({ params, reply }) => {
      const environment = system.config.environments.find((e) => e.name === params.environment);
      if (environment?.watch === undefined)
        return reply
          .code(409)
          .send({ error: 'that environment declares no watch, so a window there could ask nothing' });
      const window = store.extendWatchWindow(
        issueOrigin(params.number),
        params.environment,
        new Date(Date.now() + watchWindowMs(environment)).toISOString(),
      );
      if (window === null) return reply.code(404).send({ error: 'no watch window on that goal and environment' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, window };
    }),
  );
}
