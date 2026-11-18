import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { handledContext, recentHandled, revertHandled } from '../../handled/handled.js';
import { checked, integerParam } from '../validation.js';
import type { RouteContext } from './context.js';
import type { HandledPayload } from '../../wire.js';

// → docs/spec/16-http-api.md, docs/spec/43-handled-for-you.md

const HandledIdParams = z.object({ id: integerParam('handled action id') });
const CheckBody = z.object({ ids: z.array(z.number().int().positive()).min(1) });

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness } = system;

  app.get('/api/handled', (): HandledPayload => ({ actions: recentHandled(store, Date.now()) }));

  app.post(
    '/api/handled/check',
    checked({ body: CheckBody }, ({ body }) => {
      store.handled.check(body.ids);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );

  for (const direction of ['undo', 'redo'] as const)
    app.post(
      `/api/handled/:id/${direction}`,
      checked({ params: HandledIdParams }, async ({ params, reply }) => {
        const outcome = await revertHandled(handledContext(system.config, system), params.id, direction);
        if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
        hub.broadcast({ type: 'world:changed' });
        await harness.runCycle('manual');
        return { ok: true, action: outcome.action };
      }),
    );
}
