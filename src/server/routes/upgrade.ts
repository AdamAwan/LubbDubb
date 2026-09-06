import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { updates } = system;

  app.post('/api/upgrade/check', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => {
    await updates.check(true);
    hub.broadcast({ type: 'dirty' });
    return { ok: true, build: updates.reading() };
  });

  app.post('/api/project/pull', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (_req, reply) => {
    const result = await updates.pullProject();
    if (!result.ok) return reply.code(409).send({ error: result.error });
    hub.broadcast({ type: 'dirty' });
    return { ok: true, build: result.build };
  });

  const SnoozeBody = z.object({
    target: z.enum(['upgrade', 'projectPull'], {
      errorMap: () => ({ message: 'target must be upgrade or projectPull' }),
    }),
  });
  app.post(
    '/api/upgrade/snooze',
    checked({ body: SnoozeBody }, async ({ body }) => {
      updates.snooze(body.target);
      hub.broadcast({ type: 'dirty' });
      return { ok: true, build: updates.reading() };
    }),
  );

  const UpgradeBody = z.object({
    action: z.enum(['drain', 'cancel', 'apply'], {
      errorMap: () => ({ message: 'action must be drain, cancel or apply' }),
    }),
    interrupt: requiredBoolean('interrupt must be true or false').optional(),
  });
  app.post(
    '/api/upgrade',
    checked({ body: UpgradeBody }, async ({ body, reply }) => {
      const result = updates.request(body.action, { interrupt: body.interrupt });
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, build: updates.reading() };
    }),
  );
}
