import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ATTACHMENT_BODY_LIMIT, AttachmentsField, prepareAttachments } from '../../jobs/attachments.js';
import { submitBrief } from '../../jobs/brief.js';
import { orderedProfiles } from '../../agents/modelPolicy.js';
import { checked, IdParams, optionalText } from '../validation.js';
import type { RouteContext } from './context.js';

/** Operator-launched work: queueing a job, cancelling one, and re-ordering the queue it waits in. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, config } = system;

  // Queue an operator-launched job. It persists as `queued` and is drained by
  // the dispatcher ahead of world-driven work — taking the next free slot, or
  // waiting in the queue when the fleet is at capacity. A cycle is kicked so a
  // job dispatches immediately when there's headroom.
  const JobBody = z.object({
    prompt: z
      .string({ required_error: 'prompt required', invalid_type_error: 'prompt required' })
      .trim()
      .min(1, 'prompt required'),
    title: optionalText('title'),
    kind: z.enum(['code', 'desk'], { errorMap: () => ({ message: "kind must be 'code' or 'desk'" }) }).default('code'),
    // `null` is accepted beside absence because the cockpit sends it for "no
    // branch"; both mean the same thing to `createJob`.
    branch: z
      .union([z.string({ invalid_type_error: 'branch must be a string' }).trim(), z.null()])
      .optional()
      .transform((branch) => branch || null),
    // Images the operator pasted or picked, base64 (issue #249). The count bound
    // is here; size and format are decided on the *decoded* bytes below, which is
    // the only place they can be. See `src/jobs/attachments.ts`.
    attachments: AttachmentsField,
  });
  app.post(
    '/api/jobs',
    // Attachments ride in this JSON body, so it is the one route that may buffer
    // more than fastify's 1 MB default. Per-route rather than global: nothing else
    // on this surface has any business sending megabytes, and a body over the
    // limit is fastify's own 413 before validation runs. The route already sits
    // behind the bearer-token guard.
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    checked({ body: JobBody }, async ({ body, reply }) => {
      const { prompt, kind, branch } = body;
      const providedTitle = body.title ?? null;
      // Before anything is created: a refused attachment must leave no queued job,
      // because a brief that says "make it look like this" without the "this"
      // is worse than no brief at all.
      const prepared = prepareAttachments(body.attachments);
      if (!prepared.ok) return reply.code(400).send({ error: prepared.error });
      // Store the images against the ref the work now lives under — `job:<id>` for a
      // brief that dispatches, `issue:<n>` for one the harness filed as a ticket
      // instead. Written under the final ref rather than moved onto it later (issue
      // #394 removed the re-key with the filing agent that needed it), so an image
      // is the goal's from the moment it lands.
      //
      // Files first, rows second: an interrupted write then leaves bytes nothing
      // points at, rather than a row naming a path that does not resolve, and a path
      // an agent cannot open is the failure that matters.
      const attach = (targetRef: string): void => {
        if (prepared.files.length === 0) return;
        const stored = system.attachments.write(targetRef, prepared.files);
        store.addAttachments(
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

      // The transform a code brief goes through — filed as a watched ticket so it
      // flows through the planning funnel rather than being coded straight off the
      // prompt — is `submitBrief` (`src/jobs/brief.ts`), shared with the desktop
      // channel's `job_create`. What stays here is what is about *this* surface: the
      // attachment bytes, the broadcast, the cycle, and the shape of the reply.
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
        // Only the job arm's attachment failure reaches here, and it has already
        // cancelled the job it would have belonged to.
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

  // Re-order the "Up next" queue (issue #128). The body is the operator's desired
  // priority order of candidate origins; it replaces the whole override set, ranked
  // 0..n-1. It only re-orders the dispatcher's ranking — it never un-holds a held
  // item, and `manual-job` items stay first regardless — so it is safe to run a cycle
  // immediately so the new order takes effect and the next `/api/state` reflects it.
  const UpNextOrderBody = z.object({
    origins: z
      .array(z.string({ invalid_type_error: 'origins must be an array of strings' }), {
        required_error: 'origins must be an array of strings',
        invalid_type_error: 'origins must be an array of strings',
      })
      // A duplicate origin is two ranks for one item, which is meaningless and
      // would make the persisted order depend on insertion accident.
      .refine((origins) => new Set(origins).size === origins.length, { message: 'origins must be unique' }),
  });
  app.post(
    '/api/upnext/order',
    checked({ body: UpNextOrderBody }, async ({ body }) => {
      store.setPriorityOverrides(body.origins);
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, report };
    }),
  );

  // Price one queued row: which model profile the next dispatch on this origin
  // runs on. An empty `profile` clears the override, on the same
  // terms `/api/issues/:number/profile` uses — "no override" is the state a row
  // starts in, not a third value.
  //
  // Refused by name against the configured profiles, exactly as the goal pin is:
  // the operator's own config is refused at boot, a hand-typed label is tolerated
  // because a human wrote it on a ticket the harness cannot police, and a cockpit
  // control that can only send what the server sent it is refused at the boundary
  // — it can only be reached by a stale tab or a hand-rolled request, and either
  // way naming a profile that resolves to nothing would price nothing while
  // reading as a decision taken.
  //
  // Ordering is untouched, and so is every hold: the override says what a row runs
  // on, never when. A cycle runs immediately so the queue redraws with the new
  // price — and so a row that was about to dispatch takes it.
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
      store.setProfileOverride(body.origin, wanted);
      hub.broadcast({ type: 'world:changed' });
      const report = await harness.runCycle('manual');
      return { ok: true, profile: wanted, report };
    }),
  );

  // Drop a still-queued job before it runs. A job already dispatched can't be
  // cancelled here — kill its agent instead.
  app.post(
    '/api/jobs/:id/cancel',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const job = store.cancelJob(params.id);
      if (!job) return reply.code(409).send({ error: 'job not found or no longer queued' });
      // The one deletion in the attachment story: a brief dropped before it
      // ran is the only target nothing downstream can want the images for. Rows
      // first, files second, for the ordering reason the launch states.
      store.deleteAttachments(`job:${job.id}`);
      system.attachments.remove(`job:${job.id}`);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, job };
    }),
  );
}
