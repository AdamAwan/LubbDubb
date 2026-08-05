import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { watchLabelsFor } from '../../watchLabels.js';
import { checked, PrNumberParams, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/** The harness's own controls: beat it, clear its faults, cap it, exclude a PR. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, runtimeControl } = system;
  const { ignoreLabel } = watchLabelsFor(config.labelPrefix);

  app.post('/api/pulse', async () => {
    const report = await harness.runCycle('manual');
    return { ok: true, report };
  });

  // Clear the fault log. A POST like every other mutation on this surface, not a
  // DELETE: the auth hook and the structural route-table test that walks it both
  // key on the `/api` prefix, and one verb for one meaning is worth more here than
  // matching HTTP's. The `dirty` is what empties the panel in every open cockpit —
  // this is a delete, so a second one watching must not go on showing rows that
  // are gone.
  //
  // It opts into rate limiting for the same reason the artifact and work routes do
  // and `/api/state` does not: it writes the store on demand rather than on the
  // cockpit's poll, and a `DELETE` over a table with no bound on its row count is
  // unbounded work behind a fixed-size request. A clear is one deliberate two-step
  // click, so the ceiling sits far above any real interaction.
  app.post('/api/errors/clear', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async () => {
    const cleared = store.clearErrors();
    hub.broadcast({ type: 'dirty' });
    return { ok: true, cleared };
  });

  // Live dispatch controls (cap + pause). Changes are in-memory and ephemeral;
  // on success we broadcast so every open cockpit updates without a refetch.
  // `cap` is only checked to *be* a number here: which numbers are a legal cap is
  // `runtimeControl.apply`'s question, and it throws with the reason (caught
  // below). Two answers to one question is what a `z.number().int().positive()`
  // here would be.
  const ControlBody = z.object({
    cap: z.number({ invalid_type_error: 'cap must be a number' }).optional(),
    paused: z.boolean({ invalid_type_error: 'paused must be a boolean' }).optional(),
  });
  app.post(
    '/api/control',
    checked({ body: ControlBody }, async ({ body, reply }) => {
      // Handed over whole: `apply` reads an absent field as "leave it alone", which
      // is exactly what the optional fields above parse to.
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

  // Toggle the PR exclusion tag from the cockpit: add/remove the configured
  // exclusion label on the PR through the provider. The next snapshot reflects
  // the label and the harness leaves a tagged PR alone. Provider-agnostic — it
  // routes through the same outbound seam as replies/merges.
  const ExcludeBody = z.object({ excluded: requiredBoolean('excluded must be a boolean') });
  app.post(
    '/api/prs/:number/exclude',
    checked({ params: PrNumberParams, body: ExcludeBody }, async ({ params, body, reply }) => {
      const { number: prNumber } = params;
      const { excluded } = body;
      try {
        const result = await connector.setPrLabel({ prNumber, label: ignoreLabel, present: excluded });
        // Reflect the change immediately: refetch on the next state read, and run a
        // cycle so a now-included PR is picked up (or a now-excluded one dropped).
        hub.broadcast({ type: 'world:changed' });
        await harness.runCycle('manual');
        return { ok: true, ref: result.ref, excluded };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }),
  );
}
