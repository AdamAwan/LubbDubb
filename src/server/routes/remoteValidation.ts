import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueOrigin } from '../../plans/planning.js';
import { StateQuerySchema } from '../../validation/stateDocument.js';
import { NO_STATE_EXECUTOR, stateExecutor } from '../../remoteValidation/enabled.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  const QueryParams = IssueNumberParams.extend({ queryId: z.string().min(1, 'queryId is required') });
  const ApprovalParams = QueryParams.extend({ environment: z.string().min(1, 'environment is required') });

  const RulingBody = z.object({
    accept: z.boolean({
      required_error: 'accept is required — true to approve this query here, false to decline it',
      invalid_type_error: 'accept is required — true to approve this query here, false to decline it',
    }),
  });

  app.put(
    '/api/issues/:number/state-queries/:queryId',
    checked({ params: QueryParams, body: StateQuerySchema }, async ({ params, body, reply }) => {
      if (body.id !== params.queryId)
        return reply.code(400).send({ error: `the body declares "${body.id}" and the path names "${params.queryId}"` });
      if (stateExecutor(system.config.environments) === null) return reply.code(409).send({ error: NO_STATE_EXECUTOR });
      const origin = issueOrigin(params.number);
      const { refusals } = await system.stateQueries.declare(origin, [{ ...body, seq: 0 }], 'operator');
      hub.broadcast({ type: 'world:changed' });
      const query = store.listStateQueries().find((q) => q.originRef === origin && q.id === params.queryId) ?? null;
      return { ok: true, query, dryRun: refusals };
    }),
  );

  app.delete(
    '/api/issues/:number/state-queries/:queryId',
    checked({ params: QueryParams }, ({ params, reply }) => {
      const gone = store.deleteStateQuery(issueOrigin(params.number), params.queryId);
      if (!gone) return reply.code(404).send({ error: 'no such state query on that goal' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );

  app.post(
    '/api/issues/:number/remote-validation/:environment/queries/:queryId',
    checked({ params: ApprovalParams, body: RulingBody }, async ({ params, body, reply }) => {
      if (stateExecutor(system.config.environments, params.environment) === null)
        return reply.code(409).send({
          error:
            `"${params.environment}" declares no "validate.state.run" command, so a query accepted against it ` +
            'could never be put to anything.',
        });
      const ruled = await system.stateQueries.rule(
        issueOrigin(params.number),
        params.queryId,
        params.environment,
        body.accept,
      );
      if (ruled === null) return reply.code(404).send({ error: 'no such state query on that goal' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, query: ruled.query, reading: ruled.reading, approval: ruled.approval };
    }),
  );

  /*
   * The same consent, one row kind over: a check live on the watch is still blocked on a sheet until
   * its digest has been accepted against *this* environment. The watch asked whether the query
   * parses; the sheet asks it of a named place. → docs/spec/36-remote-validation.md
   */
  app.post(
    '/api/issues/:number/remote-validation/:environment/watch-queries/:queryId',
    checked({ params: ApprovalParams, body: RulingBody }, async ({ params, body, reply }) => {
      const environment = system.config.environments.find((e) => e.name === params.environment);
      if (environment?.watch === undefined)
        return reply.code(409).send({
          error:
            `"${params.environment}" declares no "watch.observe" command, so a query accepted against it ` +
            'could never be put to anything.',
        });
      const ruled = await system.remoteValidation.ruleWatchQuery(
        issueOrigin(params.number),
        params.queryId,
        params.environment,
        body.accept,
      );
      if (ruled === null) return reply.code(404).send({ error: 'no such watch check on that goal' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check: ruled.check, reading: ruled.reading, approved: ruled.approved };
    }),
  );
}
