import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { watchWindowMs } from '../../environments/watchWindow.js';
import { issueOrigin } from '../../plans/planning.js';
import { WatchCheckSchema, watchCheckInput } from '../../validation/watchDocument.js';
import { watchSourceRefusal } from '../../environments/watchSource.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { system, hub } = ctx;
  const { store } = system;

  const CheckParams = IssueNumberParams.extend({ checkId: z.string().min(1, 'checkId is required') });

  app.put(
    '/api/issues/:number/watch/checks/:checkId',
    checked({ params: CheckParams, body: WatchCheckSchema }, async ({ params, body, reply }) => {
      if (body.id !== params.checkId)
        return reply.code(400).send({ error: `the body declares "${body.id}" and the path names "${params.checkId}"` });
      const input = watchCheckInput(body, 0);
      const refusal = watchSourceRefusal(system.config.environments, input);
      if (refusal !== null) return reply.code(400).send({ error: refusal });
      const origin = issueOrigin(params.number);
      const check = store.watches.saveOperatorWatch(origin, input);
      hub.broadcast({ type: 'world:changed' });
      const dryRun = await system.watch.run(origin);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check, dryRun };
    }),
  );

  app.delete(
    '/api/issues/:number/watch/checks/:checkId',
    checked({ params: CheckParams }, ({ params, reply }) => {
      const gone = store.watches.deleteGoalWatch(issueOrigin(params.number), params.checkId);
      if (!gone) return reply.code(404).send({ error: 'no such check on that goal' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );

  registerAuthoredWatch(app, ctx);

  const ExtendParams = IssueNumberParams.extend({ environment: z.string().min(1, 'environment is required') });

  app.post(
    '/api/issues/:number/watch/:environment/extend',
    checked({ params: ExtendParams }, ({ params, reply }) => {
      const environment = system.config.environments.find((e) => e.name === params.environment);
      if (environment?.watch === undefined)
        return reply
          .code(409)
          .send({ error: 'that environment declares no watch, so a window there could ask nothing' });
      const window = store.watches.extendWatchWindow(
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

/** The operator's two answers to the assessor's watch. → docs/spec/29-post-deploy-watch.md#the-operator-accepts-the-set */
function registerAuthoredWatch(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;
  app.post(
    '/api/issues/:number/watch/accept',
    checked({ params: IssueNumberParams }, ({ params, reply }) => {
      const record = store.watches.acceptWatchPlan(issueOrigin(params.number));
      if (record === null)
        return reply.code(409).send({ error: 'that goal has no written watch waiting to be accepted' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, watch: record };
    }),
  );

  const SendBackBody = z.object({
    words: z
      .string({ error: 'words is required — say what the next author should do differently' })
      .trim()
      .min(1, 'words is required — say what the next author should do differently'),
  });

  app.post(
    '/api/issues/:number/watch/send-back',
    checked({ params: IssueNumberParams, body: SendBackBody }, ({ params, body, reply }) => {
      const record = store.watches.sendBackWatchPlan(issueOrigin(params.number), body.words);
      if (record === null)
        return reply.code(409).send({ error: 'that goal has no written watch waiting to be accepted' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, watch: record };
    }),
  );
}
