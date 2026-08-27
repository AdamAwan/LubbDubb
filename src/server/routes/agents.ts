import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams } from '../validation.js';
import type { AgentFilesPayload, AgentTranscript } from '../../wire.js';
import type { RouteContext } from './context.js';

/**
 * How much of a transcript the caller already holds. Absent means "all of it",
 * which is what the first read of a drawer asks for; the polls after it name what
 * they have so a quiet run costs an empty string rather than the whole record.
 */
const TranscriptQuery = z.object({
  from: z.coerce
    .number({ invalid_type_error: 'from must be a number of characters' })
    .int('from must be a whole number of characters')
    .min(0, 'from must not be negative')
    .default(0),
});

/** The fleet: one agent's transcript, and the five things an operator can say to one. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, agents } = system;

  app.get(
    '/api/agents/:id/transcript',
    checked({ params: IdParams, query: TranscriptQuery }, async ({ params, query, reply }) => {
      const { id } = params;
      const agent = store.getAgent(id);
      if (!agent) return reply.code(404).send({ error: 'agent not found' });
      const full = store.getTranscript(id);
      // Clamped rather than refused: a transcript only grows, so an offset past
      // the end is a client that read at the same moment a flush landed, not a
      // bad request — and it wants to be told the end, not given a 400.
      const from = Math.min(query.from, full.length);
      const payload: AgentTranscript = { agentId: id, from, total: full.length, transcript: full.slice(from) };
      return payload;
    }),
  );

  /**
   * The files one agent wrote, for the drawer's "files changed" list.
   *
   * Fetched when a drawer opens rather than shipped on `/api/state`, for the
   * transcript's reason above: the rows are bulk text about **one** agent. They
   * used to ride the snapshot as a whole-fleet `files` list — every file every
   * agent ever wrote, on a table nothing deletes from — which was 87% of the
   * payload, built, serialised, transferred and parsed on every refresh so that
   * one open drawer could take one agent's slice of it and the rest could be
   * thrown away. → `docs/spec/16-http-api.md#bulk-text`
   *
   * 404 on an unknown agent rather than an empty list, exactly as the transcript
   * does: an agent that wrote nothing and an agent that does not exist are
   * different answers, and only the first is a row the drawer can be open over.
   */
  app.get(
    '/api/agents/:id/files',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      if (!store.getAgent(id)) return reply.code(404).send({ error: 'agent not found' });
      return { agentId: id, files: store.listFiles(id) } satisfies AgentFilesPayload;
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

  // "No, wait" — buy `agentStallExtendMs` more before a stall park settles itself
  // done (see `AgentManager.completeExpiredStalls`). The countdown is the operator's
  // window to disagree with the harness's reading, and this is the disagreement:
  // pressing it says only "I am looking at this", which is why it takes no note and
  // records nothing. It refuses an agent that has no countdown running rather than
  // reporting success over one — an operator told they had bought time on a run that
  // is already over is worse off than one told they cannot.
  app.post(
    '/api/agents/:id/extend-stall',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const result = agents.extendStallPark(params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, expiresAt: result.expiresAt };
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
