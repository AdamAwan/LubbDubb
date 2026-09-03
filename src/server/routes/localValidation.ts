import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * Validating a goal on this machine: ask for it, and call one off.
 *
 * **The one route does two things, and the order is load-bearing.** It brings the
 * goal's code up in the machine's dev environment and *then* records a validation
 * pinned to the run that came up. Recording first would pin the row to whatever was
 * running before, which is a plan written against one branch and a reading taken
 * against another.
 *
 * **Swapping is the operator's decision, and this is where they make it.** The
 * runner's `start` stops whatever was live without asking — starting *is* swapping
 * ([23](../../../docs/spec/23-local-runs.md#one-at-a-time)) — so the refusal has to
 * be here, before it is called. A press that would take somebody's environment away
 * is answered 409 with what is running, and the cockpit asks. `swap: true` is the
 * answer coming back.
 *
 * **This one runs a cycle**, unlike every route in the local-run module beside it.
 * A validation is work: it wants an agent, and the agent's most useful minutes are
 * the ones while the environment is still coming up. Waiting for the next heartbeat
 * would spend the beginning of the bring-up on nothing.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { localRun, localValidations, store, harness, worktrees } = system;

  const Body = z.object({
    /**
     * Take the environment from whatever is in it.
     *
     * A body field rather than a second route, because it is not a different act —
     * it is the same act with the operator's consent attached. The route refuses
     * without it and says what would be stopped, which is the only place that
     * consent can be asked for: by the time the runner is called the previous
     * environment is already coming down.
     */
    swap: z.boolean().optional(),
    /**
     * Move the checkout to the tip of its branch before validating.
     *
     * Never automatic, `POST /api/local-run/refresh`'s rule and for its reason: a
     * refresh is a `reset --hard` and a `clean -fd` under a running server, and an
     * operator halfway through looking at a page is owed the choice. Validating what
     * is up now is the other answer, and it is a legitimate one.
     */
    refresh: z.boolean().optional(),
  });

  app.post(
    '/api/issues/:number/validate-locally',
    checked({ params: IssueNumberParams, body: Body }, async ({ params, body, reply }) => {
      const origin = `issue:${String(params.number)}`;

      // One at a time per goal, and this is the refusal an operator most often
      // meets: they pressed twice. It carries the row, so the cockpit can draw what
      // is already happening rather than only saying no.
      const open = localValidations.open(origin);
      if (open !== null)
        return reply.code(409).send({
          error: `#${String(params.number)} is already being validated locally — it was asked for at ${open.requestedAt}. Call that one off first if you want to start again.`,
          validation: open,
        });

      const live = store.liveLocalRun();
      if (live !== null && live.originRef !== origin && body.swap !== true) {
        const goal = /^issue:(\d+)$/.exec(live.originRef)?.[1] ?? live.originRef;
        return reply.code(409).send({
          error:
            `#${goal} is running locally on ${live.ref} (${live.status}). Validating #${String(params.number)} ` +
            'stops it first, which takes as long as this project takes to shut down. Send `swap` to go ahead.',
          live: { goal: live.originRef, ref: live.ref, status: live.status },
        });
      }

      // A teardown in flight is an operator who has just said they want this
      // environment gone; starting a validation underneath it answers the opposite
      // of the last thing they said, and the runner would queue behind the stop
      // anyway.
      if (live !== null && live.status === 'stopping')
        return reply.code(409).send({
          error: 'The local environment is being taken down. Wait for it to stop, then ask again.',
        });

      if (live === null || live.originRef !== origin) {
        // Start, or swap — one call either way, because there is one transition.
        const started = await localRun.start(origin);
        if (!started.ok) return reply.code(400).send({ error: started.error });
      } else if (body.refresh === true) {
        // Only when they asked, and only when it would move: `previewCommit`
        // resolves without touching the tree, so a refresh at the tip costs nothing
        // and is not attempted. The runner refuses one it cannot do (a turn in
        // flight, a tree that will not move) and the reason is the operator's.
        const tip = await worktrees.previewCommit(live.ref).catch(() => null);
        if (tip !== null && tip !== live.commit) {
          const refreshed = await localRun.refresh();
          if (!refreshed.ok) return reply.code(400).send({ error: refreshed.error });
        }
      }

      // Read back rather than reusing what `start` returned: a refresh rewrites the
      // commit, and the pin has to be what is *now* checked out.
      const run = store.liveLocalRun();
      if (run === null)
        return reply.code(400).send({
          error: 'The local environment stopped before the validation could be recorded. Try again.',
        });

      const validation = localValidations.request({ originRef: origin, run });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      // The rule reads the row this pulse rather than the next one, which is the
      // difference between an agent that starts writing its plan while the
      // environment boots and one that starts when it is already up.
      await harness.runCycle('manual');
      return { ok: true, validation };
    }),
  );

  app.post(
    '/api/issues/:number/validate-locally/cancel',
    checked({ params: IssueNumberParams }, async ({ params, reply }) => {
      // Required rather than a convenience: without it a validator that was killed
      // from the drawer leaves a `dispatched` row nobody will ever report against,
      // and the goal's control stays absent for good. The sweep catches that a beat
      // later; this is the operator saying so now.
      const cancelled = localValidations.cancel(`issue:${String(params.number)}`);
      if (cancelled === null)
        return reply.code(404).send({ error: `Nothing is being validated locally on #${String(params.number)}.` });
      hub.broadcast({ type: 'dirty', sections: ['goals'] });
      return { ok: true, validation: cancelled };
    }),
  );
}
