import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isRecoveryVerdict, type RecoveryVerdict } from '../../agents/crashRecovery.js';
import { formatAnswers } from '../../escalation/questionnaire.js';
import { withheldPlanRefusal } from '../planReveal.js';
import { checked, IdParams, optionalText, requiredBoolean, requiredText } from '../validation.js';
import type { System } from '../../system/system.js';
import type { Escalation } from '../../types.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

/** → docs/spec/16-http-api.md#the-plan-body-is-withheld-until-it-is-revealed */
function refuseUnrevealed(system: System, proposalId: string): string | null {
  const proposal = system.store.escalations.listProposals().find((p) => p.id === proposalId);
  return withheldPlanRefusal(system, proposal?.action.planId);
}

function answerRefusal({ store, recovery }: System, id: string, item: Escalation | null): string | null {
  const pending = store.escalations.listProposals().find((p) => p.escalationId === id && p.status === 'pending');
  if (pending)
    return `this item is a proposal (${pending.id}) — accept or reject it via /api/proposals/${pending.id}/accept|reject`;
  if (item?.context?.permission)
    return `this item is a permission request — allow or deny it via /api/escalations/${id}/permission`;
  const orphaned = item?.agentId ? recovery.pendingForAgent(item.agentId) : null;
  if (orphaned)
    return (
      `the agent that asked this crashed — decide its recovery via ` +
      `/api/recovery/${orphaned.taskId} first (restore keeps this question open)`
    );
  return null;
}

const AnswerBody = z
  .object({
    response: requiredText('response required').optional(),
    answers: z
      .array(z.string({ invalid_type_error: 'each answer must be a string or null' }).nullable())
      .min(1, 'answers required')
      .optional(),
  })
  .refine((b) => (b.response === undefined) !== (b.answers === undefined), {
    message: 'send either response (free text) or answers (one per question)',
  });

const NoteBody = z.object({ note: optionalText('note') });

const PermissionBody = NoteBody.extend({ allow: requiredBoolean('allow (boolean) required') });

const AcceptBody = NoteBody.extend({
  acknowledged: z
    .array(z.string().min(1), { invalid_type_error: 'acknowledged must be an array of caveat ids' })
    .optional(),
  answers: z
    .array(
      z.object(
        {
          id: z
            .string({ invalid_type_error: 'each answer names the caveat id it answers' })
            .min(1, 'each answer names the caveat id it answers'),
          answer: z.string({ invalid_type_error: "each answer is the operator's words, as text" }),
        },
        { invalid_type_error: 'each answer must be an object of {id, answer}' },
      ),
      { invalid_type_error: 'answers must be an array of {id, answer}' },
    )
    .optional(),
  // One entry per row the operator struck out of the set they are accepting. The reason is
  // required for the same reason `validation_plan` requires a note on every call: a null with no
  // account of itself is the failure that document keeps meeting.
  // → docs/spec/20-validation.md#declining-a-single-row
  declined: z
    .array(
      z.object(
        {
          letter: z
            .string({ invalid_type_error: 'each decline names the check letter it declines' })
            .min(1, 'each decline names the check letter it declines'),
          reason: z
            .string({ invalid_type_error: 'each decline carries your reason, as text' })
            .trim()
            .min(1, 'a declined check carries your reason — it is the only account of why it is not being run'),
        },
        { invalid_type_error: 'each decline must be an object of {letter, reason}' },
      ),
      { invalid_type_error: 'declined must be an array of {letter, reason}' },
    )
    .optional(),
});

const BackOutBody = z
  .object({
    verdict: z.enum(['close', 'hold'], { errorMap: () => ({ message: "verdict must be 'close' or 'hold'" }) }),
    note: optionalText('note'),
  })
  .refine((b) => b.verdict !== 'close' || (b.note !== undefined && b.note.trim() !== ''), {
    message: 'note is required to close a ticket — it is posted on the ticket as the reason',
  });

const RecoveryBody = z.object({
  verdict: z.custom<RecoveryVerdict>(isRecoveryVerdict, {
    message: "verdict must be 'restore', 'requeue' or 'remove'",
  }),
});

export function register(app: FastifyInstance, ctx: RouteContext): void {
  registerAnswer(app, ctx);
  registerEscalationDecisions(app, ctx);
  registerProposalDecisions(app, ctx);
  registerRecovery(app, ctx);
}

function registerAnswer(app: FastifyInstance, { system }: RouteContext): void {
  const { store, escalations } = system;
  app.post(
    '/api/escalations/:id/answer',
    checked({ params: IdParams, body: AnswerBody }, async ({ params, body, reply }) => {
      const { id } = params;
      const item = store.escalations.getEscalation(id);
      const refusal = answerRefusal(system, id, item);
      if (refusal !== null) return reply.code(409).send({ error: refusal });
      let response: string;
      if (body.answers) {
        const questions = item?.context?.questions;
        if (!Array.isArray(questions) || questions.length === 0)
          return reply.code(400).send({ error: 'this item has no questionnaire — answer it with `response`' });
        if (body.answers.length !== questions.length)
          return reply.code(400).send({ error: `expected ${questions.length} answers, got ${body.answers.length}` });
        if (body.answers.every((a) => a === null || a.trim() === ''))
          return reply.code(400).send({ error: 'answer at least one question' });
        response = formatAnswers(questions, body.answers);
      } else if (body.response) {
        response = body.response;
      } else {
        return reply.code(400).send({ error: 'response required' });
      }
      try {
        const result = escalations.answer(id, response);
        return { ok: true, ...result };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }),
  );
}

function registerEscalationDecisions(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, escalations, proposals, permissions } = system;
  app.post(
    '/api/escalations/:id/dismiss',
    checked({ params: IdParams, body: NoteBody }, async ({ params, body, reply }) => {
      const { id } = params;
      const reason = body.note;

      const pending = store.escalations.listProposals().find((p) => p.escalationId === id && p.status === 'pending');
      if (pending) {
        const unrevealed = refuseUnrevealed(system, pending.id);
        if (unrevealed !== null) return reply.code(409).send({ error: unrevealed });
        const result = proposals.reject(pending.id, reason);
        if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
        hub.broadcast({ type: 'dirty' });
        return { ok: true, dismissedAs: 'proposal_rejected', proposal: result.proposal };
      }

      const item = store.escalations.getEscalation(id);
      if (item?.context?.permission && permissions.decide(id, false, reason)) {
        hub.broadcast({ type: 'dirty' });
        return { ok: true, dismissedAs: 'permission_denied' };
      }

      try {
        const escalation = escalations.dismiss(id, reason);
        hub.broadcast({ type: 'dirty' });
        return { ok: true, dismissedAs: 'cleared', escalation };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }),
  );

  app.post(
    '/api/escalations/:id/permission',
    checked({ params: IdParams, body: PermissionBody }, async ({ params, body, reply }) => {
      const { id } = params;
      const { allow, note } = body;
      const decided = permissions.decide(id, allow, note);
      if (!decided) return reply.code(409).send({ error: 'no pending permission request for this escalation' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, allowed: allow };
    }),
  );
}

function registerProposalDecisions(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { proposals } = system;
  app.post(
    '/api/proposals/:id/accept',
    checked({ params: IdParams, body: AcceptBody }, async ({ params, body, reply }) => {
      const unrevealed = refuseUnrevealed(system, params.id);
      if (unrevealed !== null) return reply.code(409).send({ error: unrevealed });
      const result = await proposals.accept(
        params.id,
        body.note,
        body.acknowledged ?? [],
        body.answers ?? [],
        body.declined ?? [],
      );
      if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
      if ('unacknowledged' in result)
        return reply.code(400).send({
          error: `this plan raises ${result.unacknowledged.length} thing(s) to acknowledge before it can be approved`,
          unacknowledged: result.unacknowledged,
        });
      hub.broadcast({ type: 'world:changed' });
      return { ok: result.outcome !== 'failed', ...result };
    }),
  );

  app.post(
    '/api/proposals/:id/reject',
    checked({ params: IdParams, body: NoteBody }, async ({ params, body, reply }) => {
      const unrevealed = refuseUnrevealed(system, params.id);
      if (unrevealed !== null) return reply.code(409).send({ error: unrevealed });
      const result = proposals.reject(params.id, body.note);
      if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, ...result };
    }),
  );

  app.post(
    '/api/proposals/:id/back-out',
    checked({ params: IdParams, body: BackOutBody }, async ({ params, body, reply }) => {
      const unrevealed = refuseUnrevealed(system, params.id);
      if (unrevealed !== null) return reply.code(409).send({ error: unrevealed });
      const result = await proposals.backOut(params.id, body.verdict, body.note);
      if (!result)
        return reply.code(409).send({
          error: 'proposal not found, already decided, or not a plan (only a plan has a ticket to back out of)',
        });
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, ...result };
    }),
  );
}

function registerRecovery(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { harness, recovery } = system;
  app.post(
    '/api/recovery/:id',
    checked({ params: IdParams, body: RecoveryBody }, async ({ params, body, reply }) => {
      const result = recovery.decide(params.id, body.verdict);
      if (!result.ok) return reply.code(409).send({ error: result.error });
      hub.broadcast({ type: 'world:changed' });
      const remaining = recovery.pendingCount();
      const report = remaining === 0 ? await harness.runCycle('manual') : undefined;
      return { ok: true, ...result.outcome, remaining, report };
    }),
  );
}
