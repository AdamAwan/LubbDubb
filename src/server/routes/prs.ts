import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, PrNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What the operator can do to a pull request from the cockpit's pull-request
 * page — which today is one thing: put a review thread back in front of the
 * fleet.
 *
 * The page itself needs no route. Everything on it is already in the snapshot the
 * cockpit polls, because everything on it is something the harness decided
 * against: the threads and their state, the checks, the two verdicts, the agents
 * that worked the branch. A second read here would be a second answer to
 * questions `/api/state` has already answered.
 * → `docs/spec/17-cockpit.md#the-pull-request-page`
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  /** `:threadId` is the thread's root comment id — the id a `PrComment` carries and a reply threads under. */
  const ThreadParams = PrNumberParams.extend({ threadId: z.string().min(1, 'threadId is required') });

  const ReopenBody = z.object({
    reopened: z.boolean({
      required_error: 'reopened is required — true to put the thread back to the fleet, false to take the ask back',
      invalid_type_error: 'reopened is required — true to put the thread back to the fleet, false to take the ask back',
    }),
  });

  /**
   * Reopen a review thread, or take the ask back.
   *
   * **The mark is the whole write**, and the baseline is deliberately left alone.
   * The snapshot folds the marks over the stored world as it serves it, so the
   * reopen is on the next `/api/state` whether or not a cycle has run — which
   * matters, because `runCycle` coalesces while a cycle is in flight and a click
   * landing during one is followed by no world read at all. Writing it into the
   * baseline instead would cost the harness its record of what the provider
   * actually said, and with it any way to put a thread back when the operator
   * takes the ask back.
   *
   * Nothing runs a cycle. A reopened thread is picked up by rule
   * `pr-review-comment` on the next pulse under its own steam, and a pulse per
   * click would buy a beat of latency at the cost of a provider read per click.
   * → `docs/spec/07-pull-requests.md#reopening-a-thread`
   */
  app.post(
    '/api/prs/:number/threads/:threadId/reopen',
    checked({ params: ThreadParams, body: ReopenBody }, ({ params, body, reply }) => {
      const baseline = store.getWorldBaseline();
      const pr = baseline?.pullRequests.find((p) => p.number === params.number);
      // Refused rather than reported as done, for the ruling routes' reason: a
      // reopen on a thread the world does not carry is a stale page or a closed
      // pull request, and answering `ok` to either would leave the operator
      // believing the fleet had been asked for something it will never see.
      if (pr === undefined) return reply.code(404).send({ error: 'no open pull request with that number' });
      if (!pr.reviewThreads?.some((t) => t.id === params.threadId))
        return reply.code(404).send({ error: 'that pull request carries no such review thread' });

      store.setPrThreadReopened(params.number, params.threadId, body.reopened);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );
}
