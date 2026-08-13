import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ValidationCheckState } from '../../types.js';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

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

  /** `:id` is the plan, `:checkId` the check's author-chosen slug — never its letter. */
  const CheckParams = IdParams.extend({ checkId: z.string().min(1, 'checkId is required') });

  const write = (
    planId: string,
    checkId: string,
    input: { state: ValidationCheckState; note: string | null; until?: string | null },
  ): ReturnType<typeof store.recordValidationResult> => {
    const next = store.recordValidationResult(planId, checkId, {
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
    '/api/plans/:id/validation/:checkId/result',
    checked({ params: CheckParams, body: ResultBody }, async ({ params, body, reply }) => {
      const next = write(params.id, params.checkId, { state: body.result, note: body.note });
      // 409 rather than 404 because the commonest cause is not a typo: an
      // amendment withdrew the check between the sheet being drawn and the click.
      if (!next) return reply.code(409).send({ error: 'no such check on this plan, or its plan has withdrawn it' });
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
    '/api/plans/:id/validation/:checkId/defer',
    checked({ params: CheckParams, body: DeferBody }, async ({ params, body, reply }) => {
      const next = write(params.id, params.checkId, {
        state: 'deferred',
        note: body.reason,
        until: body.until ?? null,
      });
      if (!next) return reply.code(409).send({ error: 'no such check on this plan, or its plan has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  // Deliberately not doing this one. The opposite effect on the flag from a
  // deferral, and kept apart from it because collapsing the two would make one of
  // them dishonest: "the test environment is rebuilt on Thursday" is not "I am not
  // going to check this".
  const WaiveBody = z.object({ reason: requiredNote('say why this one is not being checked') });
  app.post(
    '/api/plans/:id/validation/:checkId/waive',
    checked({ params: CheckParams, body: WaiveBody }, async ({ params, body, reply }) => {
      const next = write(params.id, params.checkId, { state: 'waived', note: body.reason });
      if (!next) return reply.code(409).send({ error: 'no such check on this plan, or its plan has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  // Back to `unrun` — the undo for every one of the four above, and the only way
  // out of a waiver or a deferral. One route rather than an inverse per verb
  // because there is one thing to say: whatever was recorded about this check no
  // longer holds. It takes no note for the same reason a dismissal takes none —
  // it says nothing about the work, only that the previous reading is withdrawn.
  app.post(
    '/api/plans/:id/validation/:checkId/reset',
    checked({ params: CheckParams }, async ({ params, reply }) => {
      const next = write(params.id, params.checkId, { state: 'unrun', note: null });
      if (!next) return reply.code(409).send({ error: 'no such check on this plan, or its plan has withdrawn it' });
      return { ok: true, check: next };
    }),
  );
}
