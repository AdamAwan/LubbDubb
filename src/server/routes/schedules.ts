import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deriveJobTitle } from '../../jobs.js';
import { parseCron } from '../../schedules/cron.js';
import { nextRunAfter, scheduleJobRequest } from '../../schedules/schedule.js';
import { checked, IdParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness } = system;

  const CronField = z
    .string({ required_error: 'cron required', invalid_type_error: 'cron required' })
    .trim()
    .min(1, 'cron required');
  const KindField = z.enum(['code', 'desk'], { errorMap: () => ({ message: "kind must be 'code' or 'desk'" }) });

  const CreateBody = z.object({
    cron: CronField,
    prompt: z
      .string({ required_error: 'prompt required', invalid_type_error: 'prompt required' })
      .trim()
      .min(1, 'prompt required'),
    title: optionalText('title'),
    kind: KindField.default('code'),
  });
  app.post(
    '/api/schedules',
    checked({ body: CreateBody }, async ({ body, reply }) => {
      const parsed = parseCron(body.cron);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const schedule = store.createJobSchedule({
        title: body.title ?? deriveJobTitle(body.prompt),
        prompt: body.prompt,
        kind: body.kind,
        cron: body.cron,
        nextRunAt: nextRunAfter(body.cron, new Date()),
      });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, schedule };
    }),
  );

  const UpdateBody = z.object({
    cron: CronField.optional(),
    prompt: optionalText('prompt'),
    title: optionalText('title'),
    kind: KindField.optional(),
    enabled: z.boolean({ invalid_type_error: 'enabled must be a boolean' }).optional(),
  });
  app.post(
    '/api/schedules/:id',
    checked({ params: IdParams, body: UpdateBody }, async ({ params, body, reply }) => {
      const existing = store.getJobSchedule(params.id);
      if (!existing) return reply.code(404).send({ error: 'schedule not found' });
      if (body.cron !== undefined) {
        const parsed = parseCron(body.cron);
        if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      }
      const cron = body.cron ?? existing.cron;
      const enabled = body.enabled ?? existing.enabled;
      const reschedule = body.cron !== undefined || enabled !== existing.enabled;
      const schedule = store.updateJobSchedule(params.id, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        cron,
        enabled,
        ...(reschedule ? { nextRunAt: enabled ? nextRunAfter(cron, new Date()) : null } : {}),
      });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, schedule };
    }),
  );

  app.post(
    '/api/schedules/:id/run',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const schedule = store.getJobSchedule(params.id);
      if (!schedule) return reply.code(404).send({ error: 'schedule not found' });
      const job = store.createJob(scheduleJobRequest(schedule));
      store.recordJobScheduleRun(schedule.id, {
        firedAt: new Date().toISOString(),
        jobId: job.id,
        nextRunAt: schedule.nextRunAt,
      });
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, job, report };
    }),
  );

  app.delete(
    '/api/schedules/:id',
    checked({ params: IdParams }, async ({ params, reply }) => {
      if (!store.deleteJobSchedule(params.id)) return reply.code(404).send({ error: 'schedule not found' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );
}
