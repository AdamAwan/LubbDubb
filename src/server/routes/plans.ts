import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orderedProfiles } from '../../agents/modelPolicy.js';
import { planAmendmentProposalRef, planProposalRef } from '../../proposals/proposals.js';
import { acceptanceCriteria } from '../../plans/parts.js';
import { latestPlanDiff, proposedPlanDiff } from '../../plans/planDiff.js';
import { amendmentWarnings, supersedePlanAmendments } from '../../plans/planAmendment.js';
import { planNarrative, planPartInputs, validatePlanDocument } from '../../plans/planDocument.js';
import type { PendingPlanAmendment, PlanHistory } from '../../wire.js';
import type { PlanAmendment, PlanNarrative, PlanPartInput } from '../../types.js';
import type { ErrorRecorder } from '../../errorLog.js';
import type { Store } from '../../store/store.js';
import { AcceptanceBody, checked, IdParams, optionalText, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

/** The ways out of a plan verdict an operator does not want to simply accept or reject, plus its history. */
export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, proposals, config } = system;

  // Every verdict this plan has had, and the last amendment read as a change.
  //
  // A route of its own rather than a field on `/api/state`, for the reason the work
  // graph and the retro have theirs: it is read when a sheet is opened rather than
  // every pulse, and the write-ups it carries are the largest prose the store holds
  // — a plan replanned three times would put three of them into every poll.
  //
  // The diff is computed here rather than in the browser because it is a *reading
  // of the plan*, and the cockpit re-deriving one would be a second answer to a
  // question the server already answers. It is null on a plan with a single
  // verdict, which is not an amendment and would draw every part as "added".
  app.get(
    '/api/plans/:id/history',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      if (!store.getPlan(id)) return reply.code(404).send({ error: 'plan not found' });
      const revisions = store.listPlanRevisions(id);
      // The change waiting on the operator, read the same way the approval card
      // reads it: `proposedPlanDiff` against the latest revision, and
      // `amendmentWarnings` over the plan's live rows. Both are the server's, for
      // the diff's reason above — a second reading in the browser is a second
      // answer to a question this route already answers, and the one drawn beside
      // the card would be the other one.
      const pending = store.listPlanAmendments(id).find((a) => a.status === 'pending') ?? null;
      return {
        revisions,
        diff: latestPlanDiff(revisions),
        pending: pendingView(pending, store, system.errors),
      } satisfies PlanHistory;
    }),
  );

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
      const next = store.setPlanStatus(id, 'planning');
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
      // A pending *amendment* goes the same way, and for the sharper version of the
      // same reason: a replan replaces the document the amendment was written
      // against, so accepting it afterwards would either write a plan nobody asked
      // for over the replan or — since applying refuses outside `active` — do
      // nothing at all while telling the operator it had.
      //
      // **The rows are settled before the cards are withdrawn**, and the order is
      // the whole of what makes this a withdrawal rather than a verdict: rejecting
      // a `plan_amendment` proposal runs `declinePlanAmendment`, so a card closed
      // over a still-pending row writes `declined` — the terminal that means *an
      // operator said no*, against a question nobody was asked. Settled first, the
      // rejection finds the row already `superseded` and changes nothing about it,
      // and the card closing is only the inbox item going away.
      const pendingAmendments = store.listPlanAmendments(plan.id).filter((a) => a.status === 'pending');
      supersedePlanAmendments(store, plan.id, 'A replan replaced the plan this amendment was written against.');
      for (const amendment of pendingAmendments) {
        const amendmentRef = planAmendmentProposalRef(amendment.id);
        const card = store
          .listProposals()
          .find((p) => p.kind === 'plan_amendment' && p.ref === amendmentRef && p.status === 'pending');
        if (card) proposals.reject(card.id, 'superseded by a replan');
      }
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, plan: next };
    }),
  );

  // Tick (or un-tick) one of a part's acceptance criteria.
  //
  // The reviewer's own reading, never the harness's: nothing here derives whether a
  // criterion holds, for the reason `conclude_part` refuses to derive an outcome —
  // inferring a positive terminal from incidental evidence is the mistake the
  // harness refuses everywhere. What this adds is only that the criteria are *in
  // front of* the merged pull request instead of in a plan nobody reopens.
  //
  // Keyed on the criterion's text rather than its index, so a re-worded criterion
  // loses its tick. That is the behaviour worth having: an amendment that changes
  // what "done" means has withdrawn the thing that was confirmed.
  app.post(
    '/api/plans/:id/acceptance',
    checked({ params: IdParams, body: AcceptanceBody }, async ({ params, body, reply }) => {
      const plan = store.getPlan(params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const part = store.listPlanParts(plan.id).find((p) => p.slug === body.slug);
      if (!part) return reply.code(404).send({ error: `plan ${params.id} has no part "${body.slug}"` });
      // Refused rather than stored: a tick against text no criterion carries can
      // never be shown again, so accepting it would report a confirmation the sheet
      // would then not draw.
      const criteria = acceptanceCriteria(part);
      if (!criteria.some((c) => c.text === body.criterion))
        return reply.code(409).send({ error: 'that criterion is not one this part declares' });
      const next = body.met
        ? [...part.acceptanceMet.filter((c) => c !== body.criterion), body.criterion]
        : part.acceptanceMet.filter((c) => c !== body.criterion);
      const updated = store.setPartAcceptanceMet(part.id, next);
      hub.broadcast({ type: 'world:changed' });
      // No cycle: a reviewer's note about finished work schedules nothing, and
      // running one would be a pulse per checkbox.
      return { ok: true, part: updated };
    }),
  );

  // Override which model profile one part's work runs on (issue #342).
  //
  // The planner's claim, edited: it sized the part it had just cut, and an
  // operator reading the decomposition may know better. Clearing it (an absent or
  // empty `profile`) is its own answer rather than a synonym for the goal's
  // profile — a cleared part inherits, so re-pinning the goal later moves it too.
  //
  // Refused by name against the configured profiles, the same way the goal pin is
  // and for the same reason: this is the surface that cannot produce a bad value,
  // as distinct from a plan document, which is agent-authored and falls back
  // instead.
  const PartProfileBody = z.object({
    slug: requiredText('slug is required — the part being pinned'),
    profile: optionalText('profile'),
  });
  app.post(
    '/api/plans/:id/part-profile',
    checked({ params: IdParams, body: PartProfileBody }, async ({ params, body, reply }) => {
      const plan = store.getPlan(params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const part = store.listPlanParts(plan.id).find((p) => p.slug === body.slug);
      if (!part) return reply.code(404).send({ error: `plan ${params.id} has no part "${body.slug}"` });
      const wanted = body.profile ?? null;
      const known = orderedProfiles(config.agentModels).map((p) => p.name);
      if (wanted !== null && !known.includes(wanted))
        return reply.code(400).send({
          error:
            known.length === 0
              ? 'This deployment configures no agentModels.profiles, so there is nothing to pick.'
              : `"${wanted}" is not one of this deployment's profiles: ${known.join(', ')}.`,
        });
      const updated = store.setPartProfile(part.id, wanted);
      hub.broadcast({ type: 'world:changed' });
      // A cycle, unlike the acceptance tick above: this changes what the next
      // dispatch of a pending part costs, so an operator who re-prices one about
      // to go out wants that to land before it does.
      await harness.runCycle('manual');
      return { ok: true, part: updated };
    }),
  );
}

/**
 * A pending amendment as the plan sheet reads it, or null.
 *
 * The stored document is parsed here rather than shipped: the sheet draws the
 * diff, not the document, and a row written by an older build that no longer
 * validates has no diff to draw — so it degrades to its note and its warnings
 * rather than failing the whole history. `applyPlanAmendment` makes the same
 * reading and settles such a row where it is applied; this one only has to avoid
 * being the reason a plan sheet will not open.
 */
function pendingView(
  amendment: PlanAmendment | null,
  store: Store,
  errors: ErrorRecorder,
): PendingPlanAmendment | null {
  if (!amendment) return null;
  const declared = readDeclaration(amendment, errors);
  return {
    id: amendment.id,
    note: amendment.note,
    author: amendment.author,
    createdAt: amendment.createdAt,
    diff:
      declared === null
        ? null
        : proposedPlanDiff(store.listPlanRevisions(amendment.planId), {
            narrative: declared.narrative,
            parts: declared.parts,
          }),
    warnings:
      declared === null
        ? []
        : amendmentWarnings(
            store.listPlanParts(amendment.planId),
            declared.parts.map((p) => p.slug),
          ),
  };
}

/**
 * The stored document as the two readings above need it, or null.
 *
 * Null on anything that cannot be read — malformed JSON from a hand-edited row, a
 * document the schema has since moved past — and **recorded** rather than
 * swallowed, since a row nothing can draw is a row nothing can apply either and
 * the operator's card is about to say the same. The reading is degraded, not
 * fatal: the sheet still draws the note, which is the case being made.
 */
function readDeclaration(
  amendment: PlanAmendment,
  errors: ErrorRecorder,
): { narrative: PlanNarrative; parts: PlanPartInput[] } | null {
  try {
    const parsed = validatePlanDocument(JSON.parse(amendment.document) as unknown);
    if (!parsed.ok) {
      errors.record({
        source: 'server',
        message: `The pending amendment ${amendment.id} no longer validates, so the plan sheet draws no diff for it: ${parsed.error}`,
      });
      return null;
    }
    return { narrative: planNarrative(parsed.document), parts: planPartInputs(parsed.document) };
  } catch (err) {
    errors.record({
      source: 'server',
      message: `The pending amendment ${amendment.id} could not be read, so the plan sheet draws no diff for it`,
      detail: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
