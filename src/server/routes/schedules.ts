import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deriveJobTitle } from '../../jobs.js';
import { parseCron } from '../../schedules/cron.js';
import { nextRunAfter, scheduleJobRequest } from '../../schedules/schedule.js';
import { checked, IdParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

/**
 * Recurring briefs: writing one, editing it, running it by hand, and ending it.
 *
 * **Nothing here dispatches.** A schedule's only power is to write the same `jobs`
 * row `POST /api/jobs` writes, which rule `manual-job` then drains under the cap
 * and the pause flag like any other. That is the whole containment argument for
 * letting a clock queue work: a recurrence adds a way for work to *arrive*, and no
 * way for it to be run that did not already exist.
 *
 * **A code recurrence is not filed as a ticket**, unlike a code brief from the
 * launch route (issue #198). The convergence that route implements is for a
 * one-off intention entering the funnel; a recurrence is a standing one, and filing
 * a fresh ticket every Monday would fill the tracker with copies of one sentence
 * for the assay and the planner to judge identically each time. So a firing is
 * dispatched as the job it is, on the `job/<id>` branch of that firing.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness } = system;

  const CronField = z
    .string({ required_error: 'cron required', invalid_type_error: 'cron required' })
    .trim()
    .min(1, 'cron required');
  const KindField = z.enum(['code', 'desk'], { errorMap: () => ({ message: "kind must be 'code' or 'desk'" }) });

  // Write a recurrence. It starts enabled — an operator who typed a cron
  // expression means it to run — and no cycle is kicked, because the first thing
  // it does is due at a time that is by construction still in the future.
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
      // The parser's own sentence, handed back verbatim: it names the field and
      // what that field accepts, which is the only thing that helps somebody who
      // has just mistyped a cron expression. A second wording here would be a
      // worse one, written further from the syntax.
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

  // Edit one. Every field is optional and an absent one is left alone, so the
  // enable/disable toggle and a reworded prompt are the same call.
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
      // **The next slot is recomputed from now, never carried over**, whenever the
      // recurrence itself changed: a schedule moved from 09:00 to 21:00 that kept
      // yesterday's `next_run_at` would fire at the old time once more, which is
      // the edit visibly not taking. Disabling clears it, so a re-enable a month
      // later starts from the clock rather than from a slot that is long past —
      // otherwise switching one back on fires it instantly, which is not what a
      // toggle means.
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

  // Fire one now, without waiting for its slot. The operator's own click, so it
  // ignores both gates the pulse applies on their behalf: a disabled schedule
  // still runs (that is what the click means) and a previous firing still in
  // flight does not hold it (the pulse holds one to avoid stacking agents
  // unattended, which this is not). What it does **not** do is move `nextRunAt` —
  // running it early is not a change to the cadence.
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
      // The launch route's reason for kicking one: a job queued now should take a
      // free slot now rather than at the next heartbeat.
      const report = await harness.runCycle('manual');
      return { ok: true, job, report };
    }),
  );

  // End it. The jobs it queued are untouched — they are its history, and they are
  // ordinary jobs whether or not the intention behind them still stands.
  app.delete(
    '/api/schedules/:id',
    checked({ params: IdParams }, async ({ params, reply }) => {
      if (!store.deleteJobSchedule(params.id)) return reply.code(404).send({ error: 'schedule not found' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true };
    }),
  );
}
