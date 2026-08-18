import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { watchLabelFor } from '../../watchLabels.js';
import { checked, PrNumberParams, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/** The harness's own controls: beat it, clear its faults, cap it, watch or un-watch a PR. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, runtimeControl } = system;
  const watchLabel = watchLabelFor(config.labelPrefix);

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

  // Toggle a pull request's watch tag from the cockpit: add or remove the one
  // configured label through the provider. The next snapshot reflects it, and the
  // harness works only what carries it. Provider-agnostic — it routes through the
  // same outbound seam as replies/merges.
  //
  // Two-valued to write and to read, which is the whole of the model: there is no
  // "leave this alone" tag to set, only a tag to take off.
  const WatchBody = z.object({ watched: requiredBoolean('watched must be a boolean') });
  app.post(
    '/api/prs/:number/watch',
    checked({ params: PrNumberParams, body: WatchBody }, async ({ params, body, reply }) => {
      const { number: prNumber } = params;
      const { watched } = body;
      try {
        const result = await connector.setPrLabel({ prNumber, label: watchLabel, present: watched });
        // A human has now answered for this pull request, so the seeding desk must
        // not answer again: without the row, un-watching one the harness opened
        // before it was ever seeded would be undone on the next pulse, silently.
        // Written for *both* directions — the seed means "decided", not "tagged".
        const branch = store.getWorldBaseline()?.pullRequests.find((pr) => pr.number === prNumber)?.branch ?? '';
        store.recordPrWatchSeed(prNumber, branch);
        // Reflect the change immediately: refetch on the next state read, and run a
        // cycle so a now-watched PR is picked up (or a now-unwatched one dropped).
        hub.broadcast({ type: 'world:changed' });
        await harness.runCycle('manual');
        return { ok: true, ref: result.ref, watched };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }),
  );
}
