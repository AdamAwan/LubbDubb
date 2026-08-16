import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * What the fleet has learned about working this repository: writing one down,
 * and the two verdicts an operator can pass on it (issue #355).
 *
 * **The gate is the feature.** A lesson store with no promote step is an
 * append-only pad every agent reads, which is the thing `docs/README.md` argues
 * against about `CLAUDE.md`: a surface loaded into every agent's context has
 * length as a recurring fleet-wide cost and accuracy as a *correctness* concern,
 * because a stale line there is a false instruction handed to every agent before
 * it reads any code — and it fails silently. So a lesson is a claim until a
 * human vouches for it, exactly as a finding is, and these three routes are the
 * whole of how one moves.
 *
 * There is no list route: the lessons ride on `/api/state` with everything else
 * the cockpit polls, which is what `findings` does and for the same reason —
 * the panel draws them beside refs the snapshot's own link map resolves.
 *
 * **Nothing here reaches an agent.** No dispatcher rule reads a lesson, no
 * prompt renders one, and promoting one changes no launch argument; promotion
 * records that an operator vouched for it and nothing more. Rendering is #355's
 * phase 3, and it is a separate change with its own cap and its own spec.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store } = system;

  // Write one down. The operator's own arm — and in this phase the only writer
  // there is, since the retrospective's submission channel is #355 phase 2. It
  // lands `proposed` like everything else rather than `promoted`: the surface is
  // one gate, not one gate and a bypass for whoever happens to be typing.
  //
  // `originRef` is the goal it was learned on, and it is optional because a
  // lesson written from what an operator already knows has no goal behind it. A
  // null there is honest; a defaulted one would date the lesson to work that did
  // not teach it.
  const ProposeBody = z.object({
    text: z.string({ required_error: 'text is required' }),
    originRef: optionalText('originRef'),
  });
  app.post(
    '/api/lessons',
    checked({ body: ProposeBody }, async ({ body, reply }) => {
      const text = body.text.trim();
      if (text.length === 0) return reply.code(400).send({ error: 'text is required' });
      // Bounded here rather than at the table, for the reason the cap in #355
      // exists at all: what makes this safe is that a person reads every lesson
      // before it goes anywhere, and nobody reads an essay pasted into a list.
      if (text.length > MAX_LESSON_CHARS)
        return reply
          .code(400)
          .send({ error: `text must be ${MAX_LESSON_CHARS} characters or fewer — a lesson is a line or two` });
      const lesson = store.proposeLesson({ text, originRef: body.originRef ?? null });
      // `dirty` rather than `world:changed`: nothing in the world moved and no
      // cycle is run — the cockpit simply has a row more to draw. The same
      // reading `dismissFinding` takes.
      hub.broadcast({ type: 'dirty' });
      return { ok: true, lesson };
    }),
  );

  // Vouch for one. A promoted lesson is what a later phase will render to the
  // fleet, so this click is the only thing between a retrospective's opinion and
  // every agent's context — which is why it is a click and not a tool.
  app.post(
    '/api/lessons/:id/promote',
    checked({ params: IdParams }, async ({ params, reply }) => {
      // Read first so the two refusals are told apart: an id that names nothing
      // is a 404 whatever its status would have been, and a lesson already ruled
      // on is a 409 that says which way. The store's write is guarded on the
      // status regardless, so the read is for the wording, never for the check.
      const existing = store.getLesson(params.id);
      if (!existing) return reply.code(404).send({ error: 'lesson not found' });
      const lesson = store.promoteLesson(params.id);
      if (!lesson) return reply.code(409).send({ error: `lesson is already ${existing.status}` });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, lesson };
    }),
  );

  // Prune one — the half of this ticket that makes the other half allowed to
  // exist. From either live status: a proposal nobody wants and a promoted
  // lesson that stopped being true are the same act, and the second is the one
  // that keeps the eventual rendered block from becoming forty stale assertions.
  //
  // Terminal, and there is no un-retire. Retiring must always be available;
  // promoting is the risk, so it starts from a proposal every time.
  app.post(
    '/api/lessons/:id/retire',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const existing = store.getLesson(params.id);
      if (!existing) return reply.code(404).send({ error: 'lesson not found' });
      const lesson = store.retireLesson(params.id);
      if (!lesson) return reply.code(409).send({ error: 'lesson is already retired' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, lesson };
    }),
  );
}

/**
 * How long a lesson may be. Not a storage bound — SQLite does not care — but a
 * *readability* one: every safeguard on this surface rests on a person having
 * actually read the row before promoting it, and a wall of text is the row
 * nobody reads. Roughly a short paragraph, which is what a lesson is.
 */
const MAX_LESSON_CHARS = 2_000;
