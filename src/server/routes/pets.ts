import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams, optionalText, requiredBoolean } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * The three things an operator does to a creature: feed it, name it, and decide
 * whether it stands in the vivarium.
 *
 * **No read route.** `PetState` rides on the state snapshot with everything else
 * the cockpit draws, so the corner of the rail updates on the same socket as the
 * queue above it rather than on a poll of its own.
 *
 * Every refusal comes back from `PetKeeper` as a sentence, and every one of them
 * is a 400 returned rather than thrown — a request the operator got wrong is not
 * an unanticipated fault, and routing it to `setErrorHandler` would bury real
 * ones under it.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { pets } = system;

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
