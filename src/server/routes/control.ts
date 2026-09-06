import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { watchLabelFor } from '../../watchLabels.js';
import { checked, PrNumberParams, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, runtimeControl } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);

  app.post('/api/pulse', async () => {
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  app.post('/api/errors/clear', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => {
    const cleared = store.clearErrors();
    hub.broadcast({ type: 'dirty' });
    return { ok: true, cleared };
  });

  const ControlBody = z.object({
    cap: z.number({ invalid_type_error: 'cap must be a number' }).optional(),
    paused: z.boolean({ invalid_type_error: 'paused must be a boolean' }).optional(),
  });
  app.post(
    '/api/control',
    checked({ body: ControlBody }, async ({ body, reply }) => {
      const patch = body;
      try {
        const next = runtimeControl.apply(patch);
        hub.broadcast({ type: 'control:changed', cap: next.cap, paused: next.paused });
        return { ok: true, ...next };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }),
  );

  const WatchBody = z.object({ watched: requiredBoolean('watched must be a boolean') });
  app.post(
    '/api/prs/:number/watch',
    checked({ params: PrNumberParams, body: WatchBody }, async ({ params, body, reply }) => {
      const { number: prNumber } = params;
      const { watched } = body;
      try {
        const result = await connector.setPrLabel({ prNumber, label: watchLabel, present: watched });
        const branch = store.getWorldBaseline()?.pullRequests.find((pr) => pr.number === prNumber)?.branch ?? '';
        store.recordPrWatchSeed(prNumber, branch);
        store.patchWorldLabels({ pullRequests: [prNumber], label: watchLabel, present: watched });
        hub.broadcast({ type: 'world:changed' });
        await harness.runCycle('manual');
        return { ok: true, ref: result.ref, watched };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }),
  );
}
