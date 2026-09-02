import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { watchWindowMs } from '../../environments/watchWindow.js';
import { issueOrigin } from '../../plans/planning.js';
import { WatchCheckSchema, watchCheckInput } from '../../validation/watchDocument.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What an operator does to a goal's watch: write a check, drop one, rule on one an
 * agent declared, and give a window that ran out too soon more time.
 *
 * Four routes in one module, because they are one subject: a second module per
 * verb would be several groups for one thing the cockpit draws in one block. None
 * of them runs a cycle beyond the dry run a write owes.
 *
 * The first, because there is one decision: an agent's declaration is not live
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

  /**
   * The operator's own check, written or re-written from the goal page.
   *
   * One verb rather than a create and an update, because the slug is the merge key
   * everywhere else in this subsystem: an id the goal carries lands on that row,
   * and one it does not starts a row. Two routes would be two answers to what a
   * re-used slug means.
   *
   * **It runs the dry run in the same call**, exactly as an acceptance does and
   * for the same two reasons: a query nobody has put to an environment is a query
   * nobody has proved resolves, and a measure's baseline is that first reading
   * kept. The refusals come back so the form can say what the environment said.
   *
   * The declaration is refused by {@link WatchCheckSchema} — a plan document's own
   * rules, so a signal still cannot be written without a presence query and a
   * measure still cannot be written with nothing that could fail it. A check
   * written here is `authored: 'operator'`, which is what keeps the next replan
   * off it.
   * → `docs/spec/29-post-deploy-watch.md#the-operator-at-any-point`
   */
  app.put(
    '/api/issues/:number/watch/checks/:checkId',
    checked({ params: ProposalParams, body: WatchCheckSchema }, async ({ params, body, reply }) => {
      // The path names the check, so a body naming a different one is a client
      // editing one row and saving over another — refused rather than reconciled,
      // because either reading of it silently discards somebody's edit.
      if (body.id !== params.checkId)
        return reply.code(400).send({ error: `the body declares "${body.id}" and the path names "${params.checkId}"` });
      const origin = issueOrigin(params.number);
      // `watchCheckInput` places a check within a document, and there is no
      // document here: the position is the store's to keep or to append, so the one
      // passed is not read.
      const check = store.saveOperatorWatch(origin, watchCheckInput(body, 0));
      hub.broadcast({ type: 'world:changed' });
      const dryRun = await system.watch.run(origin);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check, dryRun };
    }),
  );

  /**
   * Drop a check.
   *
   * Whoever wrote it: a plan's check the operator has decided is wrong is exactly
   * as much theirs to remove as one they wrote, and a delete that refused the
   * plan's would leave the goal page able to fix a query but not to stop asking
   * it. The next replan re-declares the plan's own — the document still says it —
   * which is the honest outcome rather than a surprise: what the operator removed
   * is a check, not the plan's opinion.
   *
   * 404 rather than `ok` on a slug the goal does not carry, for the extension's
   * reason: a click that deleted nothing must not report that it did.
   */
  app.delete(
    '/api/issues/:number/watch/checks/:checkId',
    checked({ params: ProposalParams }, ({ params, reply }) => {
      const gone = store.deleteGoalWatch(issueOrigin(params.number), params.checkId);
      if (!gone) return reply.code(404).send({ error: 'no such check on that goal' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true };
    }),
  );

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

  /** `:environment` is the operator's own name for it — the key every window is stored against. */
  const ExtendParams = IssueNumberParams.extend({ environment: z.string().min(1, 'environment is required') });

  /**
   * Give a window more time.
   *
   * The honest answer for a watch that closed before the weekly job ran — and the
   * one thing in the subsystem that puts a settled verdict back in play, which is
   * why it is a click and not a rule. It **re-opens the window it names** rather
   * than opening a second one: `watch_windows` is keyed on `(goal, environment)`,
   * so a second window would split one goal's readings across two rows nothing
   * joins, and the readings taken before it ran out are the evidence behind
   * whatever it says next. They are untouched — the verdict that was fixed is
   * still readable, beside the new ones.
   *
   * The new end is measured from **now** and takes the environment's own `forMs`,
   * through the one function the arrival pass sizes a window with: a second
   * reading of that field is one edit from a window extending by a different
   * length from the one it opened with.
   *
   * Two refusals, and each is a different kind of no. No window on that
   * `(goal, environment)` is a stale page or a wrong name — reported as done, it
   * would leave the operator believing they had extended something. An environment
   * that no longer declares a `watch` has nothing to ask, so a window re-opened
   * there would run to its new end reading nothing at all.
   */
  app.post(
    '/api/issues/:number/watch/:environment/extend',
    checked({ params: ExtendParams }, ({ params, reply }) => {
      const environment = system.config.environments.find((e) => e.name === params.environment);
      if (environment?.watch === undefined)
        return reply
          .code(409)
          .send({ error: 'that environment declares no watch, so a window there could ask nothing' });
      const window = store.extendWatchWindow(
        issueOrigin(params.number),
        params.environment,
        new Date(Date.now() + watchWindowMs(environment)).toISOString(),
      );
      if (window === null) return reply.code(404).send({ error: 'no watch window on that goal and environment' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, window };
    }),
  );
}
