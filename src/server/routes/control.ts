import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InjectableEvent } from '../../connector/connector.js';
import { isWorldInjectable } from '../stateSnapshot.js';
import { watchLabelsFor } from '../../watchLabels.js';
import { checked, PrNumberParams, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The synthetic world events `/api/inject` accepts.
 *
 * The old check asserted the whole body to be an `InjectableEvent` and then
 * tested that `kind` was a string, which typed every other field as validated
 * while checking none of them — and this is the one body that reaches a
 * connector. Annotating the schema as
 * `z.ZodType<InjectableEvent>` is what removes the assertion rather than moving
 * it: TypeScript refuses the annotation if the parsed output is not an
 * `InjectableEvent`, so a variant that drifts from the union in `connector.ts`
 * fails `typecheck`. The other direction — the union gaining a kind this misses
 * — fails loudly at runtime as a 400 naming the kind, and only ever under the
 * `fake` provider this route is gated to.
 */
const InjectEventBody: z.ZodType<InjectableEvent> = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('ci_failed'), prNumber: z.number() }),
    z.object({ kind: z.literal('ci_passed'), prNumber: z.number() }),
    z.object({ kind: z.literal('pr_comment'), prNumber: z.number(), author: z.string(), body: z.string() }),
    z.object({
      kind: z.literal('new_pr'),
      number: z.number(),
      title: z.string(),
      branch: z.string(),
      baseBranch: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }),
    z.object({ kind: z.literal('pr_approved'), prNumber: z.number() }),
    z.object({
      kind: z.literal('pr_mergeable'),
      prNumber: z.number(),
      mergeable: z.boolean().optional(),
      mergeableState: z.enum(['dirty', 'behind', 'blocked', 'clean', 'unknown']).optional(),
    }),
    z.object({ kind: z.literal('pr_closed'), prNumber: z.number(), merged: z.boolean().optional() }),
    z.object({
      kind: z.literal('new_issue'),
      number: z.number(),
      title: z.string(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }),
    z.object({ kind: z.literal('issue_state'), number: z.number(), state: z.enum(['open', 'closed']) }),
    z.object({ kind: z.literal('issue_linked_pr'), number: z.number(), prNumber: z.number() }),
  ],
  // One wording for both "no `kind` at all" and "a kind nothing handles", since
  // the panel that sends these is a fixed set of buttons and anything else
  // reaching here is a hand-written call.
  { errorMap: () => ({ message: 'invalid event' }) },
);

/** The harness's own controls: beat it, inject a world, clear its faults, cap it, exclude a PR. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, connector, harness, config, runtimeControl } = system;
  const { ignoreLabel } = watchLabelsFor(config.labelPrefix);

  // `checked` is applied *inside* the handler rather than wrapping it, so the
  // 403 is answered before the body is read: whether this deployment injects at
  // all is not a question about the payload, and a malformed event on a real
  // provider should hear the same refusal a well-formed one does.
  app.post('/api/inject', async (req, reply) => {
    // Defence in depth: the cockpit hides the panel, but the route itself also
    // refuses when no fake provider is configured to receive the event.
    if (!isWorldInjectable(config.integrations))
      return reply.code(403).send({ error: 'event injection is only available with fake integrations' });
    return checked({ body: InjectEventBody }, async ({ body }) => {
      connector.inject(body);
      hub.broadcast({ type: 'world:changed' });
      // An injected event should provoke an immediate cycle.
      const report = await harness.runCycle('manual');
      return { ok: true, report };
    })(req, reply);
  });

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
