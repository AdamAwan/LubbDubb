import type { FastifyInstance } from 'fastify';
import { planProposalRef } from '../../proposals/proposals.js';
import { planOrigin } from '../../plans/planning.js';
import { planIssueNumber } from '../../plans/parts.js';
import { abandonDecomposition } from '../../plans/planApproval.js';
import { checked, IdParams } from '../validation.js';
import type { RouteContext } from './context.js';

/** The four ways out of a plan verdict an operator does not want to simply accept or reject. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, agents, proposals } = system;

  // Send a plan back for replanning. The mechanism already exists —
  // `resolvePlanRoute` routes a plan row in `planning` status to rule `issue-plan` — so this
  // is only the operator's way in: flip the status, and the next cycle dispatches a
  // planner primed with the current plan and part states (`issue-replan`).
  //
  // **Nothing is torn down.** Every part row is left exactly as it is: agents keep
  // running, branches stay, open PRs stay open. What an amended plan does to them is
  // decided at ingestion, where the planner's new declaration is actually known — a
  // part it no longer declares is retired only if nothing was started for it, and one
  // with a branch or a PR is kept whatever the amendment says (see `partsToRetire`).
  // Until that lands, the existing plan keeps scheduling: a replan that fails or is
  // never picked up leaves the issue exactly where it was, not parked.
  app.post(
    '/api/plans/:id/replan',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      const plan = store.getPlan(id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      let next = store.setPlanStatus(id, 'planning');
      // A replan also supersedes a running discussion — leaving `discussing` set
      // would have rule `issue-plan` render the `discuss-plan` template on its next dispatch
      // instead of the `issue-replan` one this call actually asked for, so the two
      // routes must agree about what plain `planning` means.
      if (next?.discussing) next = store.setPlanDiscussing(id, false);
      // A replan supersedes an approval that was still being asked for. Withdrawing
      // it is not optional: a pending proposal holds rule `plan-approval` off this plan, so the
      // amended verdict would never be put to anyone — and the stale card, if
      // accepted, would release a decomposition its reader never saw. The status
      // write above is what makes this safe to route through the ordinary reject:
      // the plan is no longer `awaiting_approval`, so `refusePlan` finds nothing to
      // settle and the withdrawal is only the inbox item closing.
      const ref = planProposalRef(plan.originRef);
      const pending = store.listProposals().find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
      if (pending) proposals.reject(pending.id, 'superseded by a replan');
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, plan: next };
    }),
  );

  // Abandon a released decomposition and work the issue as one pull request.
  //
  // The escape hatch for a plan approved into a wall: its parts blocked instantly
  // on the ref collision, `refusePlan` compare-and-sets against
  // `awaiting_approval` so the fall-back-to-`single` arm is gone once approved,
  // and `resolvePlanRoute` fails a spent replan back to `parts` rather than open
  // to `single`. Without this the only remaining exit is editing the database.
  //
  // The operator's own act, taken immediately rather than proposed: a proposal is a
  // standing verdict a rule re-reads, and this is one status write the person
  // clicking has already decided on. The guard that matters is `partHasWork`,
  // inside `abandonDecomposition`, so a decomposition with real work behind it is
  // refused here rather than silently collapsed.
  app.post(
    '/api/plans/:id/abandon',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      const plan = store.getPlan(id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const settled = abandonDecomposition(store, id, plan.originRef);
      if (!settled.ok) return reply.code(409).send({ error: settled.detail });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, detail: settled.detail, plan: store.getPlan(id) };
    }),
  );

  // Discuss a plan with an agent instead of accepting, rejecting or replanning it.
  //
  // Deliberately *a replan with a different prompt*, not a new mechanism: the plan
  // goes to `planning`, which is the status rule `issue-plan` already dispatches a planner
  // from, so the discussion agent inherits the origin gate (`issue:<n>:plan`, so no
  // second planner), the cooldown, the attempt cap and the fail-open — none of which
  // a bespoke path would have. `discussing` only picks the prompt.
  //
  // Nothing is scheduled while you talk: rule `plan-part` schedules parts for `active` and
  // `awaiting_approval` plans only, and rule `plan-approval` proposes for `awaiting_approval`
  // only, so no fresh card appears mid-conversation either.
  //
  // **409 unless the plan is `awaiting_approval`.** Every framing of Discuss — the
  // design, this spec, the `discuss-plan` prompt itself ("before approving it") —
  // only ever contemplates talking through a verdict that is still a pending
  // question. A *released* one is not, and starting from there manufactures a gate
  // the plan has already been through: on a `single` plan the discussion's own end
  // would write `awaiting_approval` back over an issue an operator already
  // authorised being worked whole, re-asking a question they answered; on an
  // `active` one it reopens the gate rule `plan-part` already cleared and stops
  // scheduling the remaining parts, which is exactly what `/discuss/end`'s own 409
  // exists to prevent on the way back out. (A `single` verdict *awaiting* approval
  // is a pending question like any other, and is discussable — `releasePlan` puts
  // it back to `single`, not `active`, so the empty-plan parking this guard used
  // to be about cannot happen either way.)
  app.post(
    '/api/plans/:id/discuss',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      const plan = store.getPlan(id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      if (plan.status !== 'awaiting_approval')
        return reply.code(409).send({ error: `plan ${id} is not awaiting approval (status: ${plan.status})` });
      // Order matters exactly as it does for a replan: the status write is what
      // makes the withdrawal safe, because `refusePlan` refuses to settle a plan
      // that is no longer `awaiting_approval` — so the reject below closes the inbox
      // item without retiring a single part.
      store.setPlanStatus(id, 'planning');
      const next = store.setPlanDiscussing(id, true);
      const ref = planProposalRef(plan.originRef);
      const pending = store.listProposals().find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
      if (pending) proposals.reject(pending.id, 'superseded by a discussion');
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, plan: next };
    }),
  );

  // End a discussion the operator no longer wants — the escape hatch, since the
  // agent ends itself when it submits an amended plan.
  //
  // Restoring the status is half the job and not an afterthought: clearing the
  // flag alone leaves the plan in `planning`, which is precisely what rule `issue-plan`
  // dispatches from, so the next pulse would start another planner.
  app.post(
    '/api/plans/:id/discuss/end',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      const plan = store.getPlan(id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      // Compare-and-set against `discussing`, the same discipline `releasePlan` and
      // `refusePlan` apply to `awaiting_approval`: an unguarded restore would force
      // *any* plan back to `awaiting_approval` on a stale or duplicate call — a plan
      // already `active`, with parts dispatched and agents on branches, would have
      // its approval gate reopened and rule `plan-part` would stop scheduling its parts. The
      // flag is exactly what says whether this call still names a live discussion.
      if (!plan.discussing) return reply.code(409).send({ error: `plan ${id} is not being discussed` });
      store.setPlanStatus(id, 'awaiting_approval');
      const next = store.setPlanDiscussing(id, false);
      // The plan restore is the important half and must not be undone by a completion
      // failure below — so a missing agent (already gone) or a `complete` that 409s
      // (already settled) is a no-op here, not a route failure. Left alive, the
      // planner keeps a fleet slot and a worktree with nothing to talk to (the
      // modal's discussion pane is gated on `plan.discussing`, so the reply box is
      // already gone), and a late `plan_submit` from that stale agent would revert
      // this very approval back to `awaiting_approval` a second time via ingestion.
      const issueNumber = planIssueNumber(plan.originRef);
      if (issueNumber !== null) {
        const task = store.findActiveTaskByOrigin(planOrigin(issueNumber));
        if (task?.agentId) agents.complete(task.agentId);
      }
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, plan: next };
    }),
  );
}
