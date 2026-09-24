import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ValidationCheckResultBy, ValidationCheckState } from '../../types.js';
import { checked, IssueNumberParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';
import { issueOrigin } from '../../plans/planning.js';

// → docs/spec/16-http-api.md

const requiredNote = (field: string, what: string): z.ZodType<string, z.ZodTypeDef, unknown> => {
  const message = `${field} is required — ${what}`;
  return z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);
};

const CheckParams = IssueNumberParams.extend({ checkId: z.string().min(1, 'checkId is required') });

/* A reading is one press. The note was compulsory on a `failed` and offered on a `passed`, on the
   argument that a bare result means nothing in a month — but a field nobody fills is not a record,
   it is a toll, and in practice the reasons went untyped or unread. What makes a reading safe is
   that it is *reversible*: the row says who recorded it and `Undo` puts it back. A note stays
   accepted, because an agent and the desktop channel both still write one worth having. */
const ResultBody = z.object({
  result: z.enum(['passed', 'failed'], { errorMap: () => ({ message: 'result must be "passed" or "failed"' }) }),
  note: optionalText('note'),
});

const DeferBody = z.object({
  reason: requiredNote('reason', 'say what it is waiting for'),
  until: z
    .string({ invalid_type_error: 'until must be a string saying when, or be left out' })
    .trim()
    .min(1, 'until must say when, or be left out — a deferral with no date is honest')
    .optional(),
});

const WaiveBody = z.object({ reason: optionalText('reason') });

const HandoverBody = z.object({
  to: z.enum(['fleet', 'human'], { errorMap: () => ({ message: 'to must be "fleet" or "human"' }) }),
});

/*
   The reading that answers a goal's last check settles its `validate` bench row here, rather than
   leaving it to the pulse that would have settled it a tick later: the operator recording that
   reading is looking straight at the ask, and a row that outlives its own answers reads as one
   nothing is watching. Same rule, same pass — `settleAnswered` applies the desk's `settle` arm over
   this one goal. → docs/spec/20-validation.md#saying-so-on-the-bench
*/
function settled({ system }: RouteContext, originRef: string): void {
  system.validationReady.settleAnswered(originRef);
}

function write(
  ctx: RouteContext,
  originRef: string,
  checkId: string,
  input: {
    state: ValidationCheckState;
    note: string | null;
    by: ValidationCheckResultBy | null;
    until?: string | null;
  },
): ReturnType<RouteContext['system']['store']['validation']['recordValidationResult']> {
  const next = ctx.system.store.validation.recordValidationResult(originRef, checkId, input);
  if (next) {
    settled(ctx, originRef);
    ctx.hub.broadcast({ type: 'world:changed' });
  }
  return next;
}

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const { system, hub } = ctx;
  const { store } = system;

  app.post(
    '/api/issues/:number/validation/:checkId/result',
    checked({ params: CheckParams, body: ResultBody }, async ({ params, body, reply }) => {
      const note = body.note !== undefined && body.note.length > 0 ? body.note : null;
      const next = write(ctx, issueOrigin(params.number), params.checkId, { state: body.result, note, by: 'operator' });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  app.post(
    '/api/issues/:number/validation/:checkId/defer',
    checked({ params: CheckParams, body: DeferBody }, async ({ params, body, reply }) => {
      const next = write(ctx, issueOrigin(params.number), params.checkId, {
        state: 'deferred',
        note: body.reason,
        by: 'operator',
        until: body.until ?? null,
      });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  app.post(
    '/api/issues/:number/validation/:checkId/waive',
    checked({ params: CheckParams, body: WaiveBody }, async ({ params, body, reply }) => {
      const next = write(ctx, issueOrigin(params.number), params.checkId, {
        state: 'waived',
        note: body.reason !== undefined && body.reason.length > 0 ? body.reason : null,
        by: 'operator',
      });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  app.post(
    '/api/issues/:number/validation/:checkId/handover',
    checked({ params: CheckParams, body: HandoverBody }, async ({ params, body, reply }) => {
      const current = store.validation.getValidationCheck(issueOrigin(params.number), params.checkId);
      if (!current)
        return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      if (body.to === 'fleet' && current.state !== 'unrun') {
        return reply.code(400).send({
          error: `this check reads ${current.state}; reset it first if you want the fleet to run it again`,
        });
      }
      const next = store.validation.setValidationActor(issueOrigin(params.number), params.checkId, body.to);
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      settled(ctx, issueOrigin(params.number));
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check: next };
    }),
  );

  app.post(
    '/api/issues/:number/validation/:checkId/reset',
    checked({ params: CheckParams }, async ({ params, reply }) => {
      const next = write(ctx, issueOrigin(params.number), params.checkId, { state: 'unrun', note: null, by: null });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );
}
