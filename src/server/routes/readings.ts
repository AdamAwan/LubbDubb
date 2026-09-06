import type { FastifyInstance } from 'fastify';
import type { RetrospectivePayload, ScratchpadPayload } from '../../wire.js';
import { padOriginFor } from '../../scratch/pad.js';
import { checked, RefParams } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  app.get(
    '/api/retrospectives/:ref',
    checked({ params: RefParams }, async ({ params }) => {
      return { retrospective: store.getRetrospective(params.ref) } satisfies RetrospectivePayload;
    }),
  );

  app.get(
    '/api/scratchpads/:ref',
    checked({ params: RefParams }, async ({ params, reply }) => {
      const { ref } = params;
      const padRef = padOriginFor(ref);
      if (!padRef)
        return reply
          .code(400)
          .send({ error: `${ref} is inside neither an issue nor a pull request, so it names no scratchpad` });
      return { padRef, entries: store.listScratchEntries(padRef) } satisfies ScratchpadPayload;
    }),
  );
}
