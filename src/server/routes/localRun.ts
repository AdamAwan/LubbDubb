import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The machine's one dev environment: start it on a goal, stop it, and read what the
 * session holding it up has said.
 *
 * **Start is also swap.** There is no separate route for "run a different goal
 * instead", because there is nothing else it could mean: one environment, so
 * starting the second thing is stopping the first. A `swap` route beside `start`
 * would be two names for one transition and an invitation to make them differ.
 *
 * **The output has its own route** rather than riding the state snapshot. The tail
 * is up to two hundred lines and the snapshot ships on every heartbeat and every
 * `dirty` — which includes every file an agent writes — so putting it there would
 * pay for a log nobody has open. The same argument keeps the work graph and the
 * prompt book off the snapshot.
 *
 * Nothing here runs a cycle. A local run schedules no work and changes no world, so
 * a pulse per click would be the cost of saying nothing.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { localRun } = system;

  const StartBody = z.object({
    issue: z
      .number({
        required_error: 'issue is required — the goal number, e.g. 284',
        invalid_type_error: 'issue must be a number',
      })
      .int()
      .positive(),
  });

  app.post(
    '/api/local-run',
    checked({ body: StartBody }, async ({ body, reply }) => {
      const result = await localRun.start(`issue:${body.issue}`);
      // A refusal here is an operator-shaped problem — nothing configured, or a
      // checkout that would not prepare — so it is a returned 400 carrying the
      // reason, never a throw. `setErrorHandler` means *unanticipated*.
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, run: result.run };
    }),
  );

  // No body and no id: there is one run, and "stop whatever is running" is the whole
  // request. Taking an id would let a stale panel stop a run that had already been
  // swapped out from under it — and mean the same thing whenever it was right.
  app.post(
    '/api/local-run/stop',
    checked({}, async () => {
      localRun.stop();
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );

  app.get('/api/local-run/output', async () => ({ lines: localRun.output() }));
}
