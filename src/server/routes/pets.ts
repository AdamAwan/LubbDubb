import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams, optionalText, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';
import { PET_CATALOGUE } from '../../pets/compendium.js';

/**
 * The five things an operator does to a creature: open its shell, feed it, name
 * it, decide whether it stands in the vivarium, and blend a duplicate back into
 * beats — and the one read that is not the operator's own collection.
 *
 * **The collection has no read route.** `PetState` rides on the state snapshot
 * with everything else the cockpit draws, so the corner of the rail updates on the
 * same socket as the queue above it rather than on a poll of its own. The
 * *catalogue* is the opposite case and so is fetched: it is the same bytes on
 * every request of a build, and putting a constant on a snapshot that ships every
 * heartbeat would pay for it forever.
 *
 * Every refusal comes back from `PetKeeper` as a sentence, and every one of them
 * is a 400 returned rather than thrown — a request the operator got wrong is not
 * an unanticipated fault, and routing it to `setErrorHandler` would bury real
 * ones under it.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { pets } = system;

  // No parameters and no state: what exists, what it costs and how often it turns
  // up are decided by tables this build ships, so the answer is the same for every
  // operator and every deployment. That is the point of the surface — a rate an
  // operator could move is a rate not worth reading.
  app.get('/api/pets/catalogue', async () => PET_CATALOGUE);

  // No body: opening decides nothing. The species and the tier were fixed by the
  // hash of the action that dropped it, and this only stamps the moment the
  // operator looked — so a client with anything to say here would be a client
  // deciding what it found. Repeating it is a success, not a 400: a double click
  // and a reloaded link both land here after the stamp.
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
      // `dirty` rather than `world:changed`: nothing in the world moved, the
      // cockpit simply has a fuller pet to draw.
      hub.broadcast({ type: 'dirty' });
      return { ok: true, pet: result.pet };
    }),
  );

  // An omitted or empty name restores the species' own, which is why this is
  // optional rather than required — "clear the name" and "set the name" are one
  // act, and two routes for it would be two ways to disagree about the empty case.
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

  // No body: what a blend is worth is the species' own, and a client naming the
  // amount would be a client deciding it.
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
