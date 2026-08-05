import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findingJobRequest, findingTicketFields, trackerCoordinates } from '../../mcp/findings.js';
import { checked, IdParams, optionalText, TicketTitleBody } from '../validation.js';
import type { RouteContext } from './context.js';

/** The three verdicts on a finding: do it now, file it for later, or nothing. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness } = system;

  // Promote a finding into work. **This is the only path from a finding to an
  // agent, and it starts with an operator's click** — an agent that could queue
  // jobs could put agents on the fleet (rule `manual-job` dispatches a job ahead of every
  // world-driven rule), which is a capability escalation rather than a
  // convenience. So `report_finding` files a claim, and this route is where a
  // human turns one into work. See src/mcp/findings.ts for the full argument.
  const PromoteBody = z.object({
    title: optionalText('title'),
    prompt: optionalText('prompt'),
    kind: z.enum(['code', 'desk'], { errorMap: () => ({ message: "kind must be 'code' or 'desk'" }) }).default('code'),
  });
  app.post(
    '/api/findings/:id/promote',
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const { id } = params;
      const finding = store.getFinding(id);
      if (!finding) return reply.code(404).send({ error: 'finding not found' });
      if (finding.status !== 'open') return reply.code(409).send({ error: `finding is already ${finding.status}` });
      // Read after the store answers, not with the params: a finding that does not
      // exist is a 404 whatever the body says, and the old route answered in that
      // order. `checked` applied by hand here is what puts the body's refusal
      // second while keeping it the same one refusal path as everywhere else.
      return checked({ body: PromoteBody }, async ({ body }) => {
        const derived = findingJobRequest(finding);
        // The operator may reword it before it runs; the derived text is only the default.
        const title = body.title ?? derived.title;
        const prompt = body.prompt ?? derived.prompt;
        const job = store.createJob({ title, prompt, kind: body.kind });
        // Resolve only after the job exists, so a failed create leaves the finding open.
        const resolved = store.resolveFinding(id, 'promoted', job.id);
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, finding: resolved, job, report };
      })(req, reply);
    }),
  );

  // File a finding as a ticket in the tracker — the *defer* arm, next to promote's
  // "do it now". Both are one operator click and both produce a job, and the split
  // is what each job is for: promotion dispatches an agent at the problem, filing
  // dispatches one at the tracker so the problem can wait its turn with everything
  // else. Filing is asynchronous, so the finding lands on `filing` here and reaches
  // `filed` only when the agent reports the ticket back through `link_ticket`.
  // The operator may reword the ticket's title before an agent files it; the
  // derived one is only the default (`TicketTitleBody`, shared with
  // `/api/work/:ref/file`, which offers the same override over its own).
  app.post(
    '/api/findings/:id/file',
    checked({ params: IdParams }, async ({ params, req, reply }) => {
      const { id } = params;
      const finding = store.getFinding(id);
      if (!finding) return reply.code(404).send({ error: 'finding not found' });
      if (finding.status !== 'open') return reply.code(409).send({ error: `finding is already ${finding.status}` });
      // A desk agent runs in a scratch dir, so it has no remote to infer the target
      // from; without coordinates there is nowhere to file. The cockpit hides the
      // button in this case, so reaching here means a direct call.
      const tracker = trackerCoordinates(system.config);
      if (!tracker)
        return reply
          .code(409)
          .send({ error: 'no issue tracker is configured to file into (the issues provider is fake or unconfigured)' });
      return checked({ body: TicketTitleBody }, async ({ body }) => {
        const derived = findingTicketFields(finding, tracker);
        const title = body.title ?? derived.title;
        // Rendered from the operator's template book, not built here: how a ticket
        // should be worded is exactly the sort of house style an override exists for.
        const prompt = system.prompts.render('finding-ticket', derived.vars);
        // Desk, not code: filing touches no repository, so a worktree and a branch
        // would be cut for a task that never writes a file.
        const job = store.createJob({ title, prompt, kind: 'desk' });
        // Job first, then resolve — a failed create leaves the finding open.
        const resolved = store.resolveFinding(id, 'filing', job.id);
        hub.broadcast({ type: 'world:changed' });
        const report = await harness.runCycle('manual');
        return { ok: true, finding: resolved, job, report };
      })(req, reply);
    }),
  );

  // Dismiss a finding: the operator read it and it needs nothing. It stays in the
  // list (muted) rather than being deleted — "we looked at this" is information,
  // and a verbatim re-report is deduped onto the dismissed row rather than
  // reopening it.
  app.post(
    '/api/findings/:id/dismiss',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const finding = store.resolveFinding(params.id, 'dismissed');
      if (!finding) return reply.code(409).send({ error: 'finding not found or already resolved' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, finding };
    }),
  );
}
