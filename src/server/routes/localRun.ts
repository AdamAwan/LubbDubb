import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, optionalText, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { localRun } = system;

  const StartBody = z.object({
    issue: z
      .number({
        required_error: 'issue is required — the goal number, e.g. 284',
        invalid_type_error: 'issue must be a number',
      })
      .int()
      .positive(),
    ref: optionalText('ref'),
  });

  app.post(
    '/api/local-run',
    checked({ body: StartBody }, async ({ body, reply }) => {
      const result = await localRun.start(`issue:${body.issue}`, body.ref);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, run: result.run };
    }),
  );

  app.post(
    '/api/local-run/stop',
    checked({}, async () => {
      void localRun.stop();
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );

  const MessageBody = z.object({
    text: requiredText('text is required — what to tell the session holding the environment'),
  });
  app.post(
    '/api/local-run/message',
    checked({ body: MessageBody }, async ({ body, reply }) => {
      const result = localRun.send(body.text);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty', sections: ['harness'] });
      return { ok: true };
    }),
  );

  app.post(
    '/api/local-run/refresh',
    checked({}, async ({ reply }) => {
      const result = await localRun.refresh();
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty', sections: ['harness'] });
      return { ok: true, run: result.run, moved: result.moved };
    }),
  );

  app.get('/api/local-run/output', async () => ({ lines: localRun.output() }));
}
