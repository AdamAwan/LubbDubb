import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ValidationCheckResultBy, ValidationCheckState } from '../../types.js';
import { checked, IssueNumberParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';
import { issueOrigin } from '../../plans/planning.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  const requiredNote = (field: string, what: string): z.ZodType<string, z.ZodTypeDef, unknown> => {
    const message = `${field} is required — ${what}`;
    return z.string({ required_error: message, invalid_type_error: message }).trim().min(1, message);
  };

  const CheckParams = IssueNumberParams.extend({ checkId: z.string().min(1, 'checkId is required') });

  const write = (
    originRef: string,
    checkId: string,
    input: {
      state: ValidationCheckState;
      note: string | null;
      by: ValidationCheckResultBy | null;
      until?: string | null;
    },
  ): ReturnType<typeof store.recordValidationResult> => {
    const next = store.recordValidationResult(originRef, checkId, input);
    if (next) hub.broadcast({ type: 'world:changed' });
    return next;
  };

  const ResultBody = z
    .object({
      result: z.enum(['passed', 'failed'], { errorMap: () => ({ message: 'result must be "passed" or "failed"' }) }),
      note: optionalText('note'),
    })
    .superRefine((data, ctx) => {
      if (data.result === 'failed' && (data.note === undefined || data.note.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'note is required — say what you saw, so the result means something in a month',
          path: ['note'],
        });
      }
    });
  app.post(
    '/api/issues/:number/validation/:checkId/result',
    checked({ params: CheckParams, body: ResultBody }, async ({ params, body, reply }) => {
      const note = body.note !== undefined && body.note.length > 0 ? body.note : null;
      const next = write(issueOrigin(params.number), params.checkId, { state: body.result, note, by: 'operator' });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  const DeferBody = z.object({
    reason: requiredNote('reason', 'say what it is waiting for'),
    until: z
      .string({ invalid_type_error: 'until must be a string saying when, or be left out' })
      .trim()
      .min(1, 'until must say when, or be left out — a deferral with no date is honest')
      .optional(),
  });
  app.post(
    '/api/issues/:number/validation/:checkId/defer',
    checked({ params: CheckParams, body: DeferBody }, async ({ params, body, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, {
        state: 'deferred',
        note: body.reason,
        by: 'operator',
        until: body.until ?? null,
      });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  const WaiveBody = z.object({ reason: requiredNote('reason', 'say why this one is not being checked') });
  app.post(
    '/api/issues/:number/validation/:checkId/waive',
    checked({ params: CheckParams, body: WaiveBody }, async ({ params, body, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, {
        state: 'waived',
        note: body.reason,
        by: 'operator',
      });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );

  const HandoverBody = z.object({
    to: z.enum(['fleet', 'human'], { errorMap: () => ({ message: 'to must be "fleet" or "human"' }) }),
  });
  app.post(
    '/api/issues/:number/validation/:checkId/handover',
    checked({ params: CheckParams, body: HandoverBody }, async ({ params, body, reply }) => {
      const current = store.getValidationCheck(issueOrigin(params.number), params.checkId);
      if (!current)
        return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      if (body.to === 'fleet' && current.state !== 'unrun') {
        return reply.code(400).send({
          error: `this check reads ${current.state}; reset it first if you want the fleet to run it again`,
        });
      }
      const next = store.setValidationActor(issueOrigin(params.number), params.checkId, body.to);
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, check: next };
    }),
  );

  app.post(
    '/api/issues/:number/validation/:checkId/reset',
    checked({ params: CheckParams }, async ({ params, reply }) => {
      const next = write(issueOrigin(params.number), params.checkId, { state: 'unrun', note: null, by: null });
      if (!next) return reply.code(409).send({ error: 'no such check on this goal, or an amendment has withdrawn it' });
      return { ok: true, check: next };
    }),
  );
}
