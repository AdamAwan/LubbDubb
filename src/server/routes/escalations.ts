import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isRecoveryVerdict, type RecoveryVerdict } from '../../agents/crashRecovery.js';
import { formatAnswers } from '../../escalation/questionnaire.js';
import { backOutCommentDraft } from '../../plans/planBackOut.js';
import { originIssueNumber } from '../../plans/planning.js';
import { readProposedAct } from '../../proposals/proposals.js';
import { checked, IdParams, optionalText, requiredBoolean, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';
import type { ProposalCommentDraft } from '../../wire.js';

/**
 * Everything in "Needs you": a question answered, an item cleared, a permission
 * decided, a proposed act accepted or rejected, and a crashed run's orphans.
 *
 * They are one module because they are one inbox — three of the routes here
 * exist precisely to route an item to whichever of the others actually settles
 * it, and a dismissal that only knew about one kind would wedge an agent or
 * strand a rule.
 */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, escalations, proposals, permissions, recovery } = system;

  /**
   * Two ways in, one thing out. `response` is the free-text answer to a single
   * question; `answers` is one entry per question of a questionnaire, positional
   * against `context.questions`, which the server — not the cockpit — folds into
   * the single reply the agent reads. Exactly one of them, because a request
   * carrying both leaves it ambiguous which text the agent was meant to get.
   */
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
  app.post(
    '/api/escalations/:id/answer',
    checked({ params: IdParams, body: AnswerBody }, async ({ params, body, reply }) => {
      const { id } = params;
      // An item carrying a pending proposal is a decision, not a question: free text
      // cannot be branched on, so answering one here would settle the inbox item
      // while leaving the proposal pending — which holds the rule that made it off
      // that PR for good. Refuse and name the two routes that do settle it.
      const pending = store.listProposals().find((p) => p.escalationId === id && p.status === 'pending');
      if (pending)
        return reply.code(409).send({
          error: `this item is a proposal (${pending.id}) — accept or reject it via /api/proposals/${pending.id}/accept|reject`,
        });
      // A permission request is the same shape of problem: the agent is blocked inside
      // a tool call, so free text can't be branched on and answering here would type
      // into a session that isn't at a prompt. Name the route that does settle it.
      const item = store.getEscalation(id);
      if (item?.context?.permission)
        return reply.code(409).send({
          error: `this item is a permission request — allow or deny it via /api/escalations/${id}/permission`,
        });
      // Third arm, same shape: the agent that asked this is dead and awaiting a
      // recovery verdict, so there is nothing to type into. Answering would route
      // nowhere and settle the item, losing the question — which the operator would
      // want back if they choose to restore.
      const orphaned = item?.agentId ? recovery.pendingForAgent(item.agentId) : null;
      if (orphaned)
        return reply.code(409).send({
          error:
            `the agent that asked this crashed — decide its recovery via ` +
            `/api/recovery/${orphaned.taskId} first (restore keeps this question open)`,
        });
      // Fold a questionnaire's answers into the one reply the agent receives. The
      // checks are refusals rather than best-effort padding: a mismatched array is
      // a client that disagrees with the server about what was asked, and answering
      // anyway would put an answer under the wrong question.
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

  // The reason an operator may attach to a "no" — a dismissal, a permission
  // denial, a rejected proposal, an accepted one. Four routes take it and each
  // wrote the same two checks; blank and absent mean the same thing to all four.
  const NoteBody = z.object({ note: optionalText('note') });

  // Clear an alert without answering it. The gap this closes: an item raised
  // because an agent parked stays in "Needs you" even once the thing was handled
  // outside the harness, and the only way to empty it was to type a message nobody
  // wanted sent — least of all the agent, which has to interpret it.
  //
  // Available on *every* item, which means the two kinds that carry a verdict can't
  // simply be cleared: a permission request has an agent blocked inside a tool call
  // and a proposal has a rule held off a PR, so dropping the inbox row alone would
  // wedge one and strand the other. Each is routed to its own "no" instead — the
  // same call its Deny/Reject button makes — so "dismiss" means the same thing
  // everywhere (nothing goes out, nobody is left blocked) without a special case
  // that quietly does less than it says.
  app.post(
    '/api/escalations/:id/dismiss',
    checked({ params: IdParams, body: NoteBody }, async ({ params, body, reply }) => {
      const { id } = params;
      const reason = body.note;

      const pending = store.listProposals().find((p) => p.escalationId === id && p.status === 'pending');
      if (pending) {
        const result = proposals.reject(pending.id, reason);
        if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
        hub.broadcast({ type: 'dirty' });
        return { ok: true, dismissedAs: 'proposal_rejected', proposal: result.proposal };
      }

      const item = store.getEscalation(id);
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

  // Allow or deny a permission request an agent is blocked on (issue #130 phase B).
  // Resolves the blocked `--permission-prompt-tool` call with the operator's verdict
  // and settles the inbox item — the same live agent then continues (allow) or gets
  // the denial (deny), rather than being lost the way a config-and-restart was.
  const PermissionBody = NoteBody.extend({ allow: requiredBoolean('allow (boolean) required') });
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

  // Accept a proposed act: the harness performs it, through the same `ActionSink`
  // it would have used had auto-send been on — this is the wire between "approve"
  // and "the approved thing happens" that issue #109 found missing. The verdict
  // transition is one-way, so a double-click merges once and the second call 409s.
  //
  // `acknowledged` is what the operator ticked. A plan that raises caveats
  // (`src/plans/planCaveats.ts`) is not released until the verdict names each of
  // them, and the refusal is a 400 carrying what is still unticked — the desk asks
  // before the transition, so the proposal is still pending and the click can
  // simply be made again. Absent means none were ticked, which is the right
  // reading of an older client: it releases a plan that raises nothing and refuses
  // one that does, rather than waving through the case the gate exists for.
  const AcceptBody = NoteBody.extend({
    acknowledged: z
      .array(z.string().min(1), { invalid_type_error: 'acknowledged must be an array of caveat ids' })
      .optional(),
  });
  app.post(
    '/api/proposals/:id/accept',
    checked({ params: IdParams, body: AcceptBody }, async ({ params, body, reply }) => {
      const result = await proposals.accept(params.id, body.note, body.acknowledged ?? []);
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

  // Reject it: nothing goes out, the reason is recorded, and the rule that
  // proposed it does not ask again (see `proposalHold`).
  app.post(
    '/api/proposals/:id/reject',
    checked({ params: IdParams, body: NoteBody }, async ({ params, body, reply }) => {
      const result = proposals.reject(params.id, body.note);
      if (!result) return reply.code(409).send({ error: 'proposal not found or already decided' });
      hub.broadcast({ type: 'dirty' });
      return { ok: true, ...result };
    }),
  );

  // The two ways out of a plan verdict that are not a verdict on the plan (issue
  // #109's gate, widened). Approve and Reject both agree the work is worth doing —
  // a rejection sends the goal straight back to a planner — so an operator who has
  // read a plan and concluded the *ticket* is the problem had only the wrong "no"
  // to say it with, and the harness answered by re-planning a goal nobody wanted
  // until the attempt cap ran out.
  //
  // `close` requires the comment, and that is the whole of why the two verdicts do
  // not share `NoteBody`: closing somebody's ticket is a write on a tracker that
  // outlives this harness, and one with no words on it is the "closed for reasons
  // nobody can read" the feature exists to stop. The operator writes it or asks for
  // the draft below and edits that; nothing posts a comment the harness composed
  // and nobody read. `hold` takes an optional note for the ordinary reason every
  // other "no" here does — it is recorded, and it changes nothing about what the
  // hold does.
  const BackOutBody = z
    .object({
      verdict: z.enum(['close', 'hold'], { errorMap: () => ({ message: "verdict must be 'close' or 'hold'" }) }),
      note: optionalText('note'),
    })
    .refine((b) => b.verdict !== 'close' || (b.note !== undefined && b.note.trim() !== ''), {
      message: 'note is required to close a ticket — it is posted on the ticket as the reason',
    });
  app.post(
    '/api/proposals/:id/back-out',
    checked({ params: IdParams, body: BackOutBody }, async ({ params, body, reply }) => {
      const result = await proposals.backOut(params.id, body.verdict, body.note);
      if (!result)
        return reply.code(409).send({
          error: 'proposal not found, already decided, or not a plan (only a plan has a ticket to back out of)',
        });
      // `world:changed` rather than `dirty`: the watch tag came off, and a close
      // moved the tracker item — the cockpit is drawing a world that is now wrong.
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, ...result };
    }),
  );

  // The placeholder comment, for an operator who would rather edit one than write
  // one from nothing. A route of its own rather than a field on `/api/state`, for
  // the reason `/api/plans/:id/history` is one: it is read when somebody asks for
  // it, and it carries the plan's prose, which would otherwise ride in every poll.
  //
  // It is served, never posted. The draft quotes the plan's own diagnosis so the
  // ticket's readers can see what was considered, and what actually goes on the
  // ticket is whatever the operator sends back to the route above.
  app.get(
    '/api/proposals/:id/comment-draft',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const proposal = store.getProposal(params.id);
      if (!proposal || proposal.kind !== 'plan') return reply.code(404).send({ error: 'no plan proposal by that id' });
      const read = readProposedAct(proposal);
      if (!read.ok || read.act.kind !== 'plan') return reply.code(409).send({ error: 'that proposal names no plan' });
      const plan = store.getPlan(read.act.planId);
      const issueNumber = originIssueNumber(read.act.originRef);
      if (!plan || issueNumber === null) return reply.code(404).send({ error: 'the plan behind it is gone' });
      return { draft: backOutCommentDraft(plan, issueNumber) } satisfies ProposalCommentDraft;
    }),
  );

  // Decide what happens to work the previous run left orphaned. **Until every
  // one of these is answered the harness runs no cycles at all**, so this route is
  // the only thing that can un-stick a booted-after-a-crash harness — which is why
  // it settles the verdict inline (like a proposal accept) rather than emitting an
  // action for a pulse that cannot run to pick up.
  //
  // A refusal is a 409 with the reason, and leaves the item pending: a restore the
  // runtime declines is not a decision, and the operator still has requeue and
  // remove. The cycle is kicked only once the *last* decision lands, since one
  // kicked while others are outstanding would just return the hold.
  //
  // `:id` is the **task** id, not the agent id: a restart can orphan a task before
  // its agent was ever spawned, and the task is the only identity every candidate has.
  // The verdict list lives in `crashRecovery.ts` and is checked through its own
  // predicate, so this schema does not restate the three names — a second copy
  // here is how the route and the desk come to disagree about what is on offer.
  const RecoveryBody = z.object({
    verdict: z.custom<RecoveryVerdict>(isRecoveryVerdict, {
      message: "verdict must be 'restore', 'requeue' or 'remove'",
    }),
  });
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
