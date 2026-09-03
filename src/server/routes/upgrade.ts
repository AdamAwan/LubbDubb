import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The harness's own build and the checkout it works on: take a reading, drive a
 * deliberate upgrade of the first, and fast-forward the second.
 *
 * Its own module rather than three more routes on `control.ts` for the reason
 * `app.ts`'s `ROUTE_MODULES` exists: that file owns the *fleet's* live controls —
 * cap, pause, fault log, PR exclusion — and this owns the process they run inside.
 * They share a pause flag and nothing else.
 *
 * Every refusal here comes back as a 409 with the desk's own wording rather than a
 * 400: the request was well-formed and the operator is not wrong, the world simply
 * moved — an agent started, a second cockpit already drained, upstream advanced.
 * That is the same shape the recovery route uses for a verdict someone else settled.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { updates } = system;

  // A reading on demand — what the panel's refresh asks for. Rate-limited because
  // it is the one route on this surface that reaches the *network* on request
  // rather than on the pulse, and `check(true)` deliberately skips the interval
  // that otherwise bounds how often that happens.
  app.post('/api/upgrade/check', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => {
    await updates.check(true);
    // Every open cockpit, not just the one that asked: the gauge is in the top bar
    // of all of them, and a reading one operator took is a fact for the others too.
    hub.broadcast({ type: 'dirty' });
    return { ok: true, build: updates.reading() };
  });

  // Fast-forwarding the *worked* checkout. Rate-limited on `/upgrade/check`'s
  // terms and harder, because this one reaches the network **and writes**: it is
  // a `git pull` in the operator's own repository, and a button somebody can lean
  // on is a repository being pulled forty times a minute.
  app.post('/api/project/pull', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const result = await updates.pullProject();
    if (!result.ok) return reply.code(409).send({ error: result.error });
    // The project config the pull may have just moved is picked up by the watcher
    // in `main.ts`, which broadcasts `config:changed` of its own. This one is for
    // the reading: the card has to stop saying three commits are waiting.
    hub.broadcast({ type: 'dirty' });
    return { ok: true, build: result.build };
  });

  const UpgradeBody = z.object({
    action: z.enum(['drain', 'cancel', 'apply'], {
      errorMap: () => ({ message: 'action must be drain, cancel or apply' }),
    }),
    /**
     * Stop live agents rather than refusing to apply while any are running. They
     * come back — the shutdown leaves every one resumable and the next boot restores
     * them without asking — but it is the operator's call to make, so the default is
     * the refusal and this is how it is overridden.
     */
    interrupt: requiredBoolean('interrupt must be true or false').optional(),
  });
  app.post(
    '/api/upgrade',
    checked({ body: UpgradeBody }, async ({ body, reply }) => {
      const result = updates.request(body.action, { interrupt: body.interrupt });
      if (!result.ok) return reply.code(409).send({ error: result.error });
      // An `apply` takes this process down, so a cockpit that learned about it from
      // the socket closing would have learned nothing. It can be broadcast from here
      // at all only because `main.ts` defers the handoff past this reply — see the
      // note on `onHandoff` there.
      hub.broadcast({ type: 'dirty' });
      return { ok: true, build: updates.reading() };
    }),
  );
}
