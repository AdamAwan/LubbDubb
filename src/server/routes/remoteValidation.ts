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

  const EnvironmentParams = IssueNumberParams.extend({ environment: z.string().min(1, 'environment is required') });
  const RowParams = EnvironmentParams.extend({ rowId: z.string().min(1, 'rowId is required') });

  /*
   * The press. In order: refuse 409 while a run is live for this (environment, tenant), naming it;
   * refuse 400 with nothing selected; take the pin; open the run row; broadcast; **run a cycle**.
   *
   * This is the only route in this module that runs one, `validate-locally`'s reason: the run is
   * work, and waiting for the next heartbeat would spend those minutes on nothing.
   * → docs/spec/36-remote-validation.md#the-press
   */
  app.post(
    '/api/issues/:number/remote-validation/:environment/run',
    checked({ params: EnvironmentParams }, async ({ params, reply }) => {
      const pressed = await system.remoteRuns.press(issueOrigin(params.number), params.environment);
      if (!pressed.ok) return reply.code(pressed.code).send({ error: pressed.error, live: pressed.live ?? null });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      await system.harness.runCycle('manual');
      return {
        ok: true,
        run: pressed.run,
        abandoned: pressed.abandoned,
        read: pressed.read,
        owed: pressed.owed,
      };
    }),
  );

  /*
   * Required rather than a convenience, `validate-locally/cancel`'s reason: an operator who abandons
   * a run by hand otherwise leaves it live for ever, and the sheet's press absent with it.
   */
  app.post(
    '/api/issues/:number/remote-validation/:environment/cancel',
    checked({ params: EnvironmentParams }, ({ params, reply }) => {
      const cancelled = system.remoteRuns.cancel(params.environment, null);
      if (cancelled === null)
        return reply.code(404).send({ error: `no run is live on "${params.environment}" for this goal's tenant.` });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      return { ok: true, run: cancelled };
    }),
  );

  const SelectionBody = z.object({
    selected: z.boolean({
      required_error: 'selected is required — false to take this row out of the next press, true to put it back',
      invalid_type_error: 'selected is required — false to take this row out of the next press, true to put it back',
    }),
  });

  app.post(
    '/api/issues/:number/remote-validation/:environment/rows/:rowId',
    checked({ params: RowParams, body: SelectionBody }, ({ params, body, reply }) => {
      const changed = store.setRemoteSheetRowSelected(
        issueOrigin(params.number),
        params.environment,
        params.rowId,
        body.selected,
      );
      if (!changed) return reply.code(404).send({ error: 'no such row on that sheet' });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      return { ok: true };
    }),
  );

  /*
   * The environment's own tenant commands, invoked by an operator at the gate and never per arrival:
   * provisioning is possibly very slow, and a reseed destroys the residue somebody may still be
   * reading. Where the environment provisions on demand, this press is what runs `ensureTenant` —
   * and whatever that command names is what is stamped, because the harness never invents a tenant.
   */
  app.post(
    '/api/issues/:number/remote-validation/:environment/reseed',
    checked({ params: EnvironmentParams }, async ({ params, reply }) => {
      const prepared = await system.remoteRuns.prepareTenant(params.environment);
      if (!prepared.ok) return reply.code(400).send({ error: prepared.detail, tenant: prepared.standing });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      return { ok: true, detail: prepared.detail, tenant: prepared.standing };
    }),
  );
}
