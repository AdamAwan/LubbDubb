import type { FastifyInstance } from 'fastify';
import type { BotPrsPayload } from '../../wire.js';
import { checked, PrNumberParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  app.get('/api/bot-prs', async () => (await system.botPrs.read()) satisfies BotPrsPayload);

  app.post(
    '/api/bot-prs/:number/claim',
    checked({ params: PrNumberParams }, async ({ params, reply }) => {
      const outcome = await system.botPrs.claim(params.number);
      if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.refusal });
      return { ok: true };
    }),
  );
}
