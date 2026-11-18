import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md, docs/spec/44-needs-you.md#the-wait

const SendBody = z.object({
  item: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ask'), id: z.string().trim().min(1) }),
    z.object({ kind: z.literal('pr'), number: z.number().int().positive() }),
  ]),
});

export function register(app: FastifyInstance, { system }: RouteContext): void {
  app.post(
    '/api/listen/send',
    checked({ body: SendBody }, ({ body }) => ({ ok: true, ...system.listener.send(body.item) })),
  );
}
