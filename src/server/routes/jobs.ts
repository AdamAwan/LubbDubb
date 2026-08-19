import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { trackerCoordinates } from '../../mcp/findings.js';
import { blueprintTicketFields } from '../../blueprintTicket.js';
import { watchLabelFor } from '../../watchLabels.js';
import { ATTACHMENT_BODY_LIMIT, AttachmentsField, prepareAttachments } from '../../jobs/attachments.js';
import { deriveJobTitle } from '../../jobs.js';
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
      // because a blueprint that says "make it look like this" without the "this"
      // is worse than no blueprint at all.
      const prepared = prepareAttachments(body.attachments);
      if (!prepared.ok) return reply.code(400).send({ error: prepared.error });
      // Store the images against the ref the work now lives under — `job:<id>` for a
      // blueprint that dispatches, `issue:<n>` for one the harness filed as a ticket
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

      // A code blueprint enters the workflow through the *same* door as a ticket
      // (issue #198): when a tracker is configured, it is not dispatched onto a
      // branch but filed as a **watched ticket**, so it flows through the planning
      // funnel (assay → plan → parts → work) exactly like a picked-up issue rather
      // than being coded straight off this prompt. The whole transform is here, at
      // route time — rule `manual-job` is untouched, which keeps a clean recursion
      // boundary: only operator-injected code blueprints via this route become
      // tickets, and nothing is dispatched for the filing itself.
      //
      // The harness files it rather than a desk agent (issue #394), and this arm is
      // why: the ticket must carry the effective watch label or the funnel never
      // picks it up, and an agent that forgot it left an item created, a filing
      // shown complete in the cockpit, and **nothing ever dispatched** — no error,
      // nothing red. A label the harness passes cannot be forgotten. The body was
      // already the operator's own words verbatim, so nothing was being delegated
      // but a title.
      //
      // Fallbacks are today's behaviour: a *desk* blueprint dispatches directly, and
      // a code blueprint with no tracker (`fake`/unconfigured) has nowhere to file,
      // so it too dispatches directly.
      const tracker = kind === 'code' ? trackerCoordinates(system.config) : null;
      if (tracker) {
        const watchLabel = watchLabelFor(config.labelPrefix);
        const derived = blueprintTicketFields(prompt);
        const ticketBody = system.prompts.render('blueprint-ticket-body', derived.vars);
        let ticketRef: string;
        try {
          ticketRef = await system.filing({
            title: providedTitle ?? derived.title,
            body: ticketBody,
            // Empty when the watch gate is off (`labelPrefix: ''`), and an empty
            // label must not be written: the harness then acts on every open issue
            // and there is nothing to tag.
            labels: watchLabel ? [watchLabel] : [],
          });
        } catch (err) {
          system.errors.record({
            source: 'provider',
            message: `filing a blueprint as a ticket failed: ${(err as Error).message}`,
          });
          return reply.code(502).send({ error: `the tracker refused the ticket: ${(err as Error).message}` });
        }
        // The images follow the ticket, which is what makes them the *goal's*: every
        // agent the funnel dispatches for this issue is handed them. Recorded rather
        // than raised — the ticket exists and the operator asked for it, and losing
        // the onward visibility of a screenshot is the smaller failure.
        try {
          attach(ticketRef);
        } catch (err) {
          system.errors.record({
            source: 'server',
            message:
              `The ticket ${ticketRef} was filed but its ${prepared.files.length} attachment(s) could not be ` +
              `stored: ${(err as Error).message}. Agents working it will not see them.`,
          });
        }
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, ticketRef, report };
      }

      // Refuse a branch a live task already holds, up front (issue #116). The
      // executor's identical check is the real gate and stays — a branch can go busy
      // between queueing and dispatch, so this one can't be the only one — but a 409
      // now is worth far more to the operator than a deferral they'd have to read out
      // of the decision log hours later. The two cannot drift apart because they ask
      // `Store.findActiveTaskByBranch` the same question; where they differ is only in
      // *when*, which is why this one rejects (nothing has been promised yet) and the
      // executor's defers (a queued job the operator is entitled to have retried).
      // Only for code jobs: rule `manual-job` ignores a desk job's branch entirely.
      if (kind === 'code' && branch) {
        const held = store.findActiveTaskByBranch(branch);
        if (held)
          return reply.code(409).send({
            error: `branch ${branch} is held by active task ${held.id}${held.originRef ? ` (${held.originRef})` : ''}`,
          });
      }
      // Fall back to a title derived from the prompt's first line when none is given.
      const title = providedTitle ?? deriveJobTitle(prompt);
      const job = store.createJob({ title, prompt, kind, branch });
      // A job whose images failed to land is cancelled rather than left queued
      // without them: a blueprint that says "make it look like this" without the
      // "this" is worse than no blueprint at all.
      try {
        attach(`job:${job.id}`);
      } catch (err) {
        store.cancelJob(job.id);
        throw err;
      }
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

  // Drop a still-queued job before it runs. A job already dispatched can't be
  // cancelled here — kill its agent instead.
  app.post(
    '/api/jobs/:id/cancel',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const job = store.cancelJob(params.id);
      if (!job) return reply.code(409).send({ error: 'job not found or no longer queued' });
      // The one deletion in the attachment story: a blueprint dropped before it
      // ran is the only target nothing downstream can want the images for. Rows
      // first, files second, for the ordering reason the launch states.
      store.deleteAttachments(`job:${job.id}`);
      system.attachments.remove(`job:${job.id}`);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, job };
    }),
  );
}
