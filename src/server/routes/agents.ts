import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { checked, IdParams, optionalText } from '../validation.js';
import { orderedProfiles, resolveAgentProfile } from '../../agents/modelPolicy.js';
import type { AgentFilesPayload, AgentTranscript } from '../../wire.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

const TranscriptQuery = z.object({
  from: z.coerce
    .number({ invalid_type_error: 'from must be a number of characters' })
    .int('from must be a whole number of characters')
    .min(0, 'from must not be negative')
    .default(0),
});

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, agents, config } = system;

  app.get(
    '/api/agents/:id/transcript',
    checked({ params: IdParams, query: TranscriptQuery }, async ({ params, query, reply }) => {
      const { id } = params;
      const agent = store.agents.getAgent(id);
      if (!agent) return reply.code(404).send({ error: 'agent not found' });
      const full = store.transcripts.getTranscript(id);
      const from = Math.min(query.from, full.length);
      const payload: AgentTranscript = { agentId: id, from, total: full.length, transcript: full.slice(from) };
      return payload;
    }),
  );

  app.get(
    '/api/agents/:id/files',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      if (!store.agents.getAgent(id)) return reply.code(404).send({ error: 'agent not found' });
      return { agentId: id, files: store.agents.listFiles(id) } satisfies AgentFilesPayload;
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

  const LiftBody = z.object({ profile: optionalText('profile') });
  app.post(
    '/api/agents/:id/profile',
    checked({ params: IdParams, body: LiftBody }, async ({ params, body, reply }) => {
      const wanted = body.profile ?? null;
      const known = orderedProfiles(config.agentModels).map((p) => p.name);
      if (wanted === null || !known.includes(wanted))
        return reply.code(400).send({
          error:
            known.length === 0
              ? 'This deployment configures no agentModels.profiles, so there is nothing to lift to.'
              : `"${wanted ?? ''}" is not one of this deployment's profiles: ${known.join(', ')}.`,
        });
      const agent = store.agents.getAgent(params.id);
      if (!agent) return reply.code(404).send({ error: 'agent not found' });
      const task = store.tasks.getTask(agent.taskId);
      const resolved = resolveAgentProfile(config.agentModels, task?.rule, wanted);
      if (!resolved) return reply.code(400).send({ error: `"${wanted}" could not be resolved to a model.` });
      const result = agents.lift(params.id, resolved);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, profile: wanted, agentId: result.agentId, taskId: result.taskId };
    }),
  );

  app.post(
    '/api/agents/:id/complete',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const ok = agents.complete(params.id);
      return ok ? { ok: true } : reply.code(409).send({ error: 'agent not live' });
    }),
  );

  app.post(
    '/api/agents/:id/extend-stall',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const result = agents.extendStallPark(params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, expiresAt: result.expiresAt };
    }),
  );

  app.post(
    '/api/agents/:id/resume',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const result = agents.resumeParked(params.id);
      if (!result.ok) return reply.code(409).send({ error: result.error });
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
