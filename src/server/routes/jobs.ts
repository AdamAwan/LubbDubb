import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ATTACHMENT_BODY_LIMIT, AttachmentsField, prepareAttachments } from '../../jobs/attachments.js';
import { submitBrief } from '../../jobs/brief.js';
import { orderedProfiles } from '../../agents/modelPolicy.js';
import { checked, IdParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, config } = system;

  const JobBody = z.object({
    prompt: z
      .string({ required_error: 'prompt required', invalid_type_error: 'prompt required' })
      .trim()
      .min(1, 'prompt required'),
    title: optionalText('title'),
    kind: z.enum(['code', 'desk'], { errorMap: () => ({ message: "kind must be 'code' or 'desk'" }) }).default('code'),
    branch: z
      .union([z.string({ invalid_type_error: 'branch must be a string' }).trim(), z.null()])
      .optional()
      .transform((branch) => branch || null),
    attachments: AttachmentsField,
  });
  app.post(
    '/api/jobs',
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    checked({ body: JobBody }, async ({ body, reply }) => {
      const { prompt, kind, branch } = body;
      const providedTitle = body.title ?? null;
      const prepared = prepareAttachments(body.attachments);
      if (!prepared.ok) return reply.code(400).send({ error: prepared.error });
      const attach = (targetRef: string): void => {
        if (prepared.files.length === 0) return;
        const stored = system.attachments.write(targetRef, prepared.files);
        store.jobs.addAttachments(
          targetRef,
          stored.map((file) => ({
            index: file.index,
            label: file.label,
            mime: file.mime,
            bytes: file.data.length,
            path: file.path,
          })),
        );
      };

      let outcome;
      try {
        outcome = await submitBrief(
          {
            store,
            config,
            filing: system.filing,
            errors: system.errors,
            renderTicketBody: (vars) => system.prompts.render('brief-ticket-body', vars),
            attach,
          },
          { prompt, title: providedTitle, kind, branch },
        );
      } catch (err) {
        return reply.code(500).send({ error: (err as Error).message });
      }
      if (!outcome.ok) return reply.code(outcome.reason === 'branch_busy' ? 409 : 502).send({ error: outcome.error });
      if (outcome.kind === 'ticket') {
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, ticketRef: outcome.ticketRef, report };
      }
      const job = outcome.job;
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, job, report };
    }),
  );

  const UpNextOrderBody = z.object({
    origins: z
      .array(z.string({ invalid_type_error: 'origins must be an array of strings' }), {
        required_error: 'origins must be an array of strings',
        invalid_type_error: 'origins must be an array of strings',
      })
      .refine((origins) => new Set(origins).size === origins.length, { message: 'origins must be unique' }),
  });
  app.post(
    '/api/upnext/order',
    checked({ body: UpNextOrderBody }, async ({ body }) => {
      store.priority.setPriorityOverrides(body.origins);
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, report };
    }),
  );

  const UpNextProfileBody = z.object({
    origin: z
      .string({ required_error: 'origin required', invalid_type_error: 'origin required' })
      .trim()
      .min(1, 'origin required'),
    profile: optionalText('profile'),
  });
  app.post(
    '/api/upnext/profile',
    checked({ body: UpNextProfileBody }, async ({ body, reply }) => {
      const wanted = body.profile ?? null;
      const known = orderedProfiles(config.agentModels).map((p) => p.name);
      if (wanted !== null && !known.includes(wanted))
        return reply.code(400).send({
          error:
            known.length === 0
              ? 'This deployment configures no agentModels.profiles, so there is nothing to pick.'
              : `"${wanted}" is not one of this deployment's profiles: ${known.join(', ')}.`,
        });
      store.profileOverrides.setProfileOverride(body.origin, wanted);
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, profile: wanted, report };
    }),
  );

  app.post(
    '/api/jobs/:id/cancel',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const job = store.jobs.cancelJob(params.id);
      if (!job) return reply.code(409).send({ error: 'job not found or no longer queued' });
      store.jobs.deleteAttachments(`job:${job.id}`);
      system.attachments.remove(`job:${job.id}`);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, job };
    }),
  );
}
