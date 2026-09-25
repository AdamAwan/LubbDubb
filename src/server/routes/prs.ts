import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, PrNumberParams, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;
  registerAssignRoutes(app, { system, hub });

  const ThreadParams = PrNumberParams.extend({ threadId: z.string().min(1, 'threadId is required') });

  const ReopenBody = z.object({
    reopened: z.boolean({
      required_error: 'reopened is required — true to put the thread back to the fleet, false to take the ask back',
      invalid_type_error: 'reopened is required — true to put the thread back to the fleet, false to take the ask back',
    }),
  });

  app.post(
    '/api/prs/:number/threads/:threadId/reopen',
    checked({ params: ThreadParams, body: ReopenBody }, ({ params, body, reply }) => {
      const baseline = store.world.getWorldBaseline();
      const pr = baseline?.pullRequests.find((p) => p.number === params.number);
      if (pr === undefined) return reply.code(404).send({ error: 'no open pull request with that number' });
      if (!pr.reviewThreads?.some((t) => t.id === params.threadId))
        return reply.code(404).send({ error: 'that pull request carries no such review thread' });

      store.threadReopens.setPrThreadReopened(params.number, params.threadId, body.reopened);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );
}

const AssignBody = z.object({
  personId: requiredText('personId is required — the shortlisted person to put on the pull request'),
});

function registerAssignRoutes(app: FastifyInstance, { system, hub }: Pick<RouteContext, 'system' | 'hub'>): void {
  const { store, prAssign } = system;
  const openPr = (number: number) => store.world.getWorldBaseline()?.pullRequests.find((p) => p.number === number);

  app.post(
    '/api/prs/:number/assign',
    checked({ params: PrNumberParams, body: AssignBody }, async ({ params, body, reply }) => {
      if (openPr(params.number) === undefined)
        return reply.code(404).send({ error: 'no open pull request with that number' });
      const outcome = await prAssign.assign(
        params.number,
        body.personId,
        store.world.getWorldBaseline()?.pullRequests ?? [],
      );
      if (!outcome.ok) return reply.code(409).send({ error: outcome.refusal });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );

  app.post(
    '/api/prs/:number/assign/decline',
    checked({ params: PrNumberParams }, ({ params, reply }) => {
      if (openPr(params.number) === undefined)
        return reply.code(404).send({ error: 'no open pull request with that number' });
      prAssign.decline(params.number);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );
}
