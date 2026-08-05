import type { FastifyInstance } from 'fastify';
import type { RetrospectivePayload, ScratchpadPayload } from '../../wire.js';
import { padOriginFor } from '../../scratch/pad.js';
import { checked, RefParams } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What a goal's run left behind, read on open rather than polled: the
 * retrospective document and the shared pad the agents on it wrote each other.
 *
 * Both are unbounded prose and both are fetched when a reader opens them, which
 * is why `/api/state` carries only the summary line and the entry count — enough
 * for a way in to draw itself, and nothing that grows with what was written.
 */
export function register(app: FastifyInstance, { system }: RouteContext): void {
  const { store } = system;

  // The document itself, fetched when a reader opens it rather than shipped on
  // every poll. Null rather than 404 for a goal nobody wrote up: "no retrospective"
  // is an ordinary answer here, not a missing resource.
  app.get(
    '/api/retrospectives/:ref',
    checked({ params: RefParams }, async ({ params }) => {
      return { retrospective: store.getRetrospective(params.ref) } satisfies RetrospectivePayload;
    }),
  );

  // The shared pad, whole and in the order it was written — the testimony the
  // retrospective is written *from*, which until now only an agent could read
  // (`scratch_read`) and only a retro agent could quote.
  //
  // Fetched rather than polled for the retrospective's reason, with more force: a
  // pad is unbounded prose from every agent on the goal. The snapshot carries the
  // count and the age, which is all a way in needs to draw itself.
  //
  // The ref is resolved through the **same `padOriginFor`** an agent's write goes
  // through, so a part's origin names the pad its author writes to and the two
  // sides cannot disagree about which pad a ref means. A ref naming no pad at all
  // is a bad request rather than an empty one: "nobody has written here" and "that
  // is not a pad" are different answers, and only the first is silence.
  app.get(
    '/api/scratchpads/:ref',
    checked({ params: RefParams }, async ({ params, reply }) => {
      const { ref } = params;
      const padRef = padOriginFor(ref);
      if (!padRef) return reply.code(400).send({ error: `${ref} is not inside an issue, so it names no scratchpad` });
      return { padRef, entries: store.listScratchEntries(padRef) } satisfies ScratchpadPayload;
    }),
  );
}
