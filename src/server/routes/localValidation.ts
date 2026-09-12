import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueOriginNumber, issueOriginRef } from '../../issueOrigins.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { localRun, localValidations, store, harness, worktrees } = system;

  const Body = z.object({
    swap: z.boolean().optional(),
    refresh: z.boolean().optional(),
  });

  app.post(
    '/api/issues/:number/validate-locally',
    checked({ params: IssueNumberParams, body: Body }, async ({ params, body, reply }) => {
      const origin = issueOriginRef('root', params.number);

      const open = localValidations.open(origin);
      if (open !== null)
        return reply.code(409).send({
          error: `#${String(params.number)} is already being validated locally — it was asked for at ${open.requestedAt}. Call that one off first if you want to start again.`,
          validation: open,
        });

      const live = store.localRuns.liveLocalRun();
      if (live !== null && live.originRef !== origin && body.swap !== true) {
        const goal = issueOriginNumber('root', live.originRef) ?? live.originRef;
        return reply.code(409).send({
          error:
            `#${goal} is running locally on ${live.ref} (${live.status}). Validating #${String(params.number)} ` +
            'stops it first, which takes as long as this project takes to shut down. Send `swap` to go ahead.',
          live: { goal: live.originRef, ref: live.ref, status: live.status },
        });
      }

      if (live !== null && live.status === 'stopping')
        return reply.code(409).send({
          error: 'The local environment is being taken down. Wait for it to stop, then ask again.',
        });

      if (live === null || live.originRef !== origin) {
        const started = await localRun.start(origin);
        if (!started.ok) return reply.code(400).send({ error: started.error });
      } else if (body.refresh === true) {
        const tip = await worktrees.previewCommit(live.ref).catch(() => null);
        if (tip !== null && tip !== live.commit) {
          const refreshed = await localRun.refresh();
          if (!refreshed.ok) return reply.code(400).send({ error: refreshed.error });
        }
      }

      const run = store.localRuns.liveLocalRun();
      if (run === null)
        return reply.code(400).send({
          error: 'The local environment stopped before the validation could be recorded. Try again.',
        });

      const validation = localValidations.request({ originRef: origin, run });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      await harness.runCycle('manual');
      return { ok: true, validation };
    }),
  );

  app.post(
    '/api/issues/:number/validate-locally/cancel',
    checked({ params: IssueNumberParams }, async ({ params, reply }) => {
      const cancelled = localValidations.cancel(issueOriginRef('root', params.number));
      if (cancelled === null)
        return reply.code(404).send({ error: `Nothing is being validated locally on #${String(params.number)}.` });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      return { ok: true, validation: cancelled };
    }),
  );
}
