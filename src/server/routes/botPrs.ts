import type { FastifyInstance } from 'fastify';
import type { BotPrsPayload } from '../../wire.js';
import { checked, PrNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  app.get('/api/bot-prs', async () => {
    const reading = await system.botPrs.read();
    return {
      ...reading,
      pullRequests: system.botPrRisks.assessed(reading.pullRequests),
      risk: system.botPrRisks.standing(),
    } satisfies BotPrsPayload;
  });

  app.post(
    '/api/bot-prs/:number/claim',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      const outcome = await system.botPrs.claim(params.number);
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.refusal });
      return { ok: true };
    }),
  );

  app.post('/api/bot-prs/risk', async (_req, reply) => {
    const outcome = await system.botPrRisks.request('operator');
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.refusal });
    return { ok: true, prs: outcome.run.subjects.length };
  });
}
