import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

/** The fleet: one agent's transcript, and the five things an operator can say to one. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, agents } = system;

  app.get(
    '/api/agents/:id/transcript',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      const agent = store.getAgent(id);
      if (!agent) return reply.code(404).send({ error: 'agent not found' });
      return { agentId: id, transcript: store.getTranscript(id) };
    }),
  );

  const RespondBody = z.object({
    text: z.string({ required_error: 'text required', invalid_type_error: 'text required' }).min(1, 'text required'),
  });
  app.post(
    '/api/agents/:id/respond',
    checked({ params: IdParams, body: RespondBody }, async ({ params, body, reply }) => {
      const ok = agents.respond(params.id, body.text);
      return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
    }),
  );

  app.post(
    '/api/agents/:id/kill',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const ok = agents.kill(params.id);
      return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
    }),
  );

  // "This is finished" — the verdict only the agent could reach before, via the
  // done sentinel. Stops the process and records the clean terminal (task `done`,
  // worktree reclaimed on the reap), unlike kill, which records an abandonment.
  app.post(
    '/api/agents/:id/complete',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const ok = agents.complete(params.id);
      return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
    }),
  );

  // "The limit has cleared, carry on" — the one way out of a usage-limit park
  // (issue #318). It is not `respond`: there is no question and nothing to type,
  // and the session is usually gone, since `claude` exits with the exhausted
  // account. Resuming re-opens *that* conversation in *that* worktree.
  //
  // The refusal is the manager's own sentence rather than a flat "not live",
  // because the two ways to reach it are worth telling apart: an agent parked on a
  // question is not resumable this way, and one whose park a restart has already
  // handed to the recovery desk is answered there instead.
  app.post(
    '/api/agents/:id/resume',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const result = agents.resumeParked(params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      // The row, the fleet's live count and the park chip all move together, and all
      // three ride the snapshot rather than a frame of their own.
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );

  app.post(
    '/api/agents/:id/interrupt',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const ok = agents.interrupt(params.id);
      return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
    }),
  );
}
