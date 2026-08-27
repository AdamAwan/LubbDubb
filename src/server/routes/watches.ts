import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { issueOrigin } from '../../plans/planning.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The operator's ruling on a check an agent declared.
 *
 * One route, because there is one decision: an agent's declaration is not live
 * until somebody accepts it, and accepting is what puts the query to the
 * operator's own telemetry with the operator's own credential. That approval is
 * the whole authorisation story for this subsystem — nothing else in it asks
 * anybody for anything.
 *
 * **Accepting runs the dry run**, in the same call, and hands back what the
 * environment said. That is not a convenience: it is the same guard a planner's
 * submission gets, and skipping it here would leave the one declaration nobody
 * reviewed as the one nobody proved resolves. It is also what takes a measure's
 * baseline — the number the work has to beat, read before the arrival.
 *
 * Nothing here runs a cycle. A watch gates no dispatch and concludes no goal, and
 * a pulse per click would be the cost of saying nothing.
 * → `docs/spec/29-post-deploy-watch.md#the-working-agent-at-conclude-time`
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  /** `:number` is the goal, `:checkId` the author's own slug — the merge key, never a position. */
  const ProposalParams = IssueNumberParams.extend({ checkId: z.string().min(1, 'checkId is required') });

  const RulingBody = z.object({
    accept: z.boolean({
      required_error: 'accept is required — true to run this check, false to decline it',
      invalid_type_error: 'accept is required — true to run this check, false to decline it',
    }),
  });

  app.post(
    '/api/issues/:number/watch-proposals/:checkId',
    checked({ params: ProposalParams, body: RulingBody }, async ({ params, body, reply }) => {
      const origin = issueOrigin(params.number);
      const ruled = store.ruleOnWatchProposal(origin, params.checkId, body.accept);
      // Refused rather than reported as done: a ruling on a proposal that is not
      // there is either a stale sheet or the wrong slug, and answering `ok` to
      // both would leave the operator believing they had accepted something.
      if (ruled === null && body.accept)
        return reply.code(404).send({ error: 'no pending watch declaration on that check' });
      hub.broadcast({ type: 'world:changed' });
      // Only an acceptance asks anything: a declined declaration is one nobody
      // authorised, so putting its query to an environment to say so would be the
      // approval running the query it exists to gate.
      const refusals = body.accept ? await system.watch.run(origin) : [];
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check: ruled, dryRun: refusals };
    }),
  );
}
