import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ejection } from '../../types.js';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const EjectBody = z.object({
  reason: z
    .string({ required_error: 'reason required', invalid_type_error: 'reason required' })
    .trim()
    .min(1, 'reason required — say why you are taking this off the fleet'),
});

const SettleBody = z.object({
  outcome: z.enum(['handed_back', 'requeued', 'delivered'], {
    errorMap: () => ({ message: 'outcome must be handed_back, requeued or delivered' }),
  }),
  note: z
    .string({ invalid_type_error: 'note must be text — what you did with the work while you held it' })
    .trim()
    .optional(),
});

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { ejections } = system;

  app.post(
    '/api/agents/:id/eject',
    checked({ params: IdParams, body: EjectBody }, async ({ params, body, reply }) => {
      const result = ejections.eject(params.id, body.reason);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, ejection: result.ejection satisfies Ejection };
    }),
  );

  app.post(
    '/api/ejections/:id/settle',
    checked({ params: IdParams, body: SettleBody }, async ({ params, body, reply }) => {
      const result = ejections.settle(params.id, body.outcome, body.note ?? null);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, ejection: result.ejection satisfies Ejection, jobId: result.jobId };
    }),
  );
}
