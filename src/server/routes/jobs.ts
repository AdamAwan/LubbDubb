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
      // Store the images against whichever job row this launch creates — the
      // blueprint itself, or the desk filing job the tracker fork turns it into.
      // Files first, rows second: an interrupted write then leaves bytes nothing
      // points at, rather than a row naming a path that does not resolve, and a
      // path an agent cannot open is the failure that matters. A job whose images
      // failed to land is cancelled rather than left queued without them.
      const attach = (jobId: string): void => {
        if (prepared.files.length === 0) return;
        try {
          const stored = system.attachments.write(`job:${jobId}`, prepared.files);
          store.addAttachments(
            `job:${jobId}`,
            stored.map((file) => ({
              index: file.index,
              label: file.label,
              mime: file.mime,
              bytes: file.data.length,
              path: file.path,
            })),
          );
        } catch (err) {
          store.cancelJob(jobId);
          throw err;
        }
      };

      // A code blueprint enters the workflow through the *same* door as a ticket
      // (issue #198): when a tracker is configured, it is not dispatched onto a
      // branch but filed as a **watched ticket**, so it flows through the planning
      // funnel (assay → plan → parts → work) exactly like a picked-up issue rather
      // than being coded straight off this prompt. The whole transform is here, at
      // route time — rule `manual-job` is untouched, which keeps a clean recursion boundary:
      // only operator-injected code blueprints via this route become tickets, and
      // the desk filing job they become never does.
      //
      // Fallbacks are today's behaviour: a *desk* blueprint dispatches directly, and
      // a code blueprint with no tracker (`fake`/unconfigured) has nowhere to file,
      // so it too dispatches directly.
      const tracker = kind === 'code' ? trackerCoordinates(system.config) : null;
      if (tracker) {
        const watchLabel = watchLabelFor(config.labelPrefix);
        const derived = blueprintTicketFields(prompt, tracker, watchLabel);
        // Desk, not code: filing touches no repository, so a worktree and a branch
        // would be cut for a task that never writes a file. It is also what stops
        // this recursing — a desk job is never itself an injected code blueprint.
        const job = store.createJob({
          title: providedTitle ?? derived.title,
          prompt: system.prompts.render('blueprint-ticket', derived.vars),
          kind: 'desk',
        });
        // The desk job's own ref is what it files *for* — there is no prior work
        // node behind a blueprint, unlike an unrecorded-work filing. The row is how
        // `link_ticket` resolves the created issue back from the agent's credential
        // (agent → task → `job:<id>` origin → this filing); the fold then stands the
        // issue node up and hangs this desk job under it. Job first, then the row, so
        // a failed create leaves nothing dangling.
        const filing = store.createWorkItemFiling({ targetRef: `job:${job.id}`, jobId: job.id });
        // The attachments follow the job that was actually created — here, the
        // *filing* job. That is what lets them survive the fork: `link_ticket`
        // resolves this filing from the filing agent's credential, so the same ref
        // that carries the images is the one that learns the issue number.
        attach(job.id);
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, job, filing, report };
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
      attach(job.id);
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
