import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams, optionalText, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';
import { PET_CATALOGUE } from '../../pets/compendium.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { pets } = system;

  app.get('/api/pets/catalogue', async () => PET_CATALOGUE);

  app.post(
    '/api/pets/:id/open',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const result = pets.open(params.id);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, pet: result.pet };
    }),
  );

  const FeedBody = z.object({
    beats: z.number({ required_error: 'beats is required', invalid_type_error: 'beats must be a number' }),
  });
  app.post(
    '/api/pets/:id/feed',
    checked({ params: IdParams, body: FeedBody }, async ({ params, body, reply }) => {
      const result = pets.feed(params.id, body.beats);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, pet: result.pet };
    }),
  );

  const NameBody = z.object({ name: optionalText('name') });
  app.post(
    '/api/pets/:id/name',
    checked({ params: IdParams, body: NameBody }, async ({ params, body, reply }) => {
      const name = body.name?.trim();
      const result = pets.rename(params.id, name === undefined || name.length === 0 ? null : name);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, pet: result.pet };
    }),
  );

  app.post(
    '/api/pets/:id/blend',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const result = pets.blend(params.id);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, pet: result.pet };
    }),
  );

  const PlaceBody = z.object({ placed: requiredBoolean('placed must be true or false') });
  app.post(
    '/api/pets/:id/place',
    checked({ params: IdParams, body: PlaceBody }, async ({ params, body, reply }) => {
      const result = pets.place(params.id, body.placed);
      if (!result.ok) return reply.code(400).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, pet: result.pet };
    }),
  );
}
