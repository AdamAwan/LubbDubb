import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ValidationCheckState } from '../../types.js';
import { checked, IssueNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';
import { issueOrigin } from '../../plans/planning.js';

/**
 * Recording what somebody concluded about one validation check, and undoing it.
 *
 * Every route here writes the *operator's own reading* and derives nothing. That
 * is the discipline `/api/plans/:id/acceptance` states and `conclude_part`
 * enforces one layer down: a positive terminal inferred from incidental evidence
 * — a green build, a merged pull request, an absence of errors — is a check
 * nobody ran, recorded as one that passed.
 *
 * **No cycle is run by any of them.** Nothing here schedules work: a validation
 * result gates no dispatch, holds no merge and concludes no goal. It changes what
 * closing the goal *looks like*, and a pulse per checkbox would be the cost of
 * saying nothing.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  /**
   * A note is required on every one of these, and **not trimmed to nothing
   * silently** — the schema refuses blank in the same words it refuses absent.
   * `conclude_work`'s rule, for its reason: a reading an operator acts on later
   * must not be a state with no account of itself. A pass says what was seen; a
   * failure says what happened; a deferral says what it is waiting for; a waiver
   * says why it is not being done.
   */
  const requiredNote = (what: string): z.ZodType<string, z.ZodTypeDef, unknown> =>
    z
      .string({ required_error: `note is required — ${what}`, invalid_type_error: `note is required — ${what}` })
      .trim()
      .min(1, `note is required — ${what}`);

  /**
   * `:number` is the **goal**, `:checkId` the check's author-chosen slug — never
   * its letter. Keyed on the goal because that is what a check belongs to: the
   * plan was only ever standing in for it.
   */
  const CheckParams = IssueNumberParams.extend({ checkId: z.string().min(1, 'checkId is required') });

  const write = (
    originRef: string,
    checkId: string,
    input: { state: ValidationCheckState; note: string | null; until?: string | null },
  ): ReturnType<typeof store.recordValidationResult> => {
    const next = store.recordValidationResult(originRef, checkId, {
      ...input,
      by: input.note === null ? null : 'operator',
    });
    if (next) hub.broadcast({ type: 'world:changed' });
    return next;
  };

  // Mark a check passed or failed. The operator's own reading, and the only thing
  // that ever writes one by hand.
  const ResultBody = z.object({
    result: z.enum(['passed', 'failed'], {
      required_error: 'result must be "passed" or "failed"',
      invalid_type_error: 'result must be "passed" or "failed"',
    }),
    note: requiredNote('say what you saw, so the result means something in a month'),
  });
  app.post(
    '/api/issues/:number/validation/:checkId/result',
    checked({ params: CheckParams, body: ResultBody }, async ({ params, body, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, { state: body.result, note: body.note });
      // 409 rather than 404 because the commonest cause is not a typo: an
      // amendment withdrew the check between the sheet being drawn and the click.
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  // Put a check down and say what it is waiting for. **Deferral cannot be used to
  // reach a clear goal** — it takes the check out of today's work and leaves it in
  // the count, which is the whole guard. Otherwise it becomes the quiet exit that
  // `unrun` is loud about.
  const DeferBody = z.object({
    reason: requiredNote('say what it is waiting for'),
    /** Optional: a deferral with no date is honest, and one made to invent a date is not. */
    until: z.string().trim().min(1).optional(),
  });
  app.post(
    '/api/issues/:number/validation/:checkId/defer',
    checked({ params: CheckParams, body: DeferBody }, async ({ params, body, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, {
        state: 'deferred',
        note: body.reason,
        until: body.until ?? null,
      });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  // Deliberately not doing this one. The opposite effect on the flag from a
  // deferral, and kept apart from it because collapsing the two would make one of
  // them dishonest: "the test environment is rebuilt on Thursday" is not "I am not
  // going to check this".
  const WaiveBody = z.object({ reason: requiredNote('say why this one is not being checked') });
  app.post(
    '/api/issues/:number/validation/:checkId/waive',
    checked({ params: CheckParams, body: WaiveBody }, async ({ params, body, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, { state: 'waived', note: body.reason });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  /**
   * Hand a check to the fleet, or take it back. **The only writer of `actor`**,
   * and an operator route on purpose: whether an agent can run a check is a
   * property of the deployment — what logins it has, whether anything can drive
   * a browser — which the planner writing the check cannot know and the agent
   * running it cannot decide for itself. `fleetCandidate` is the planner's
   * argument for pressing this; it is not this.
   */
  const HandoverBody = z.object({
    to: z.enum(['fleet', 'human'], {
      required_error: 'to must be "fleet" or "human"',
      invalid_type_error: 'to must be "fleet" or "human"',
    }),
  });
  app.post(
    '/api/issues/:number/validation/:checkId/handover',
    checked({ params: CheckParams, body: HandoverBody }, async ({ params, body, reply }) => {
      const current = store.getValidationCheck(issueOrigin(params.number), params.checkId);
      if (!current)
        return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      // Refused rather than silently doing nothing, which is what handing over a
      // settled check would amount to: the rule only ever dispatches an `unrun`
      // one, so this would otherwise look like it took and never move. Refusing
      // also protects the reading — an agent re-running a check behind the person
      // who settled it would overwrite their answer with its own.
      if (body.to === 'fleet' && current.state !== 'unrun') {
        return reply.code(400).send({
          error: `this check reads ${current.state}; reset it first if you want the fleet to run it again`,
        });
      }
      const next = store.setValidationActor(issueOrigin(params.number), params.checkId, body.to);
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      // No cycle: the rule picks it up on the next pulse like any other world
      // fact, and a pulse per hand-over is this module's standing refusal.
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check: next };
    }),
  );

  // Back to `unrun` — the undo for every one of the four above, and the only way
  // out of a waiver or a deferral. One route rather than an inverse per verb
  // because there is one thing to say: whatever was recorded about this check no
  // longer holds. It takes no note for the same reason a dismissal takes none —
  // it says nothing about the work, only that the previous reading is withdrawn.
  app.post(
    '/api/issues/:number/validation/:checkId/reset',
    checked({ params: CheckParams }, async ({ params, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, { state: 'unrun', note: null });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );
}
