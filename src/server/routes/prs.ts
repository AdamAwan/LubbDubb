import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, PrNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

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
