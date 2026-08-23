import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The machine's one dev environment: start it on a goal, stop it, and read what the
 * session holding it up has said.
 *
 * **Stopping is asynchronous**, and that is the one thing about this module that is
 * not obvious: it runs the project's own stop instruction in a session, so the reply
 * says "started stopping" and the run sits in `stopping` until the turn ends.
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
    /**
     * Run an earlier part of the goal rather than the tip of its stack.
     *
     * Its shape is all this schema can check — that it is one of *this goal's* part
     * branches is a question about the plan, so the runner asks it. A schema that
     * accepted any string and a runner that trusted it would make this route a way
     * to check out anything in the repository.
     */
    ref: optionalText('ref'),
  });

  app.post(
    '/api/local-run',
    checked({ body: StartBody }, async ({ body, reply }) => {
      const result = await localRun.start(`issue:${body.issue}`, body.ref);
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
      // Started, not awaited. A stop is a session's turn now — the project's own stop
      // command, because a dev environment is not a process tree — so awaiting it here
      // would hold a request open for up to two minutes. The run goes to `stopping`,
      // which is a live status, and the runner's own `changed` events carry the rest.
      void localRun.stop();
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );

  app.get('/api/local-run/output', async () => ({ lines: localRun.output() }));
}
