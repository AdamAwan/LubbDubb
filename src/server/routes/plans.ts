import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orderedProfiles } from '../../agents/modelPolicy.js';
import { planAmendmentProposalRef, planProposalRef } from '../../proposals/proposals.js';
import { acceptanceCriteria, planIssueNumber } from '../../plans/parts.js';
import { partRestartRefusal, restartPlanPart } from '../../plans/partRestart.js';
import { latestPlanDiff, proposedPlanDiff } from '../../plans/planDiff.js';
import { amendPlanInPlace, amendmentWarnings, supersedePlanAmendments } from '../../plans/planAmendment.js';
import { regroupedDocument } from '../../plans/regroup.js';
import { planNarrative, planPartInputs, validatePlanDocument } from '../../plans/planDocument.js';
import type { PendingPlanAmendment, PlanHistory } from '../../wire.js';
import type { PlanAmendment, PlanNarrative, PlanPartInput } from '../../types.js';
import type { ErrorRecorder } from '../../errorLog.js';
import type { Store } from '../../store/store.js';
import { AcceptanceBody, checked, IdParams, optionalText, requiredText } from '../validation.js';
import type { RouteContext } from './context.js';

// → docs/spec/16-http-api.md

export function register(app: FastifyInstance, { system, hub }: RouteContext): void {
  const { store, harness, proposals, config } = system;

  app.get(
    '/api/plans/:id/history',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      if (!store.plans.getPlan(id)) return reply.code(404).send({ error: 'plan not found' });
      const revisions = store.plans.listPlanRevisions(id);
      const pending = store.plans.listPlanAmendments(id).find((a) => a.status === 'pending') ?? null;
      return {
        revisions,
        diff: latestPlanDiff(revisions),
        pending: pendingView(pending, store, system.errors),
      } satisfies PlanHistory;
    }),
  );

  app.post(
    '/api/plans/:id/replan',
    checked({ params: IdParams }, async ({ params, reply }) => {
      const { id } = params;
      const plan = store.plans.getPlan(id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const next = store.plans.setPlanStatus(id, 'planning');
      const ref = planProposalRef(plan.originRef);
      const pending = store.escalations
        .listProposals()
        .find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
      if (pending) proposals.reject(pending.id, 'superseded by a replan');
      const pendingAmendments = store.plans.listPlanAmendments(plan.id).filter((a) => a.status === 'pending');
      supersedePlanAmendments(store, plan.id, 'A replan replaced the plan this amendment was written against.');
      for (const amendment of pendingAmendments) {
        const amendmentRef = planAmendmentProposalRef(amendment.id);
        const card = store.escalations
          .listProposals()
          .find((p) => p.kind === 'plan_amendment' && p.ref === amendmentRef && p.status === 'pending');
        if (card) proposals.reject(card.id, 'superseded by a replan');
      }
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, plan: next };
    }),
  );

  app.post(
    '/api/plans/:id/acceptance',
    checked({ params: IdParams, body: AcceptanceBody }, async ({ params, body, reply }) => {
      const plan = store.plans.getPlan(params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const part = store.plans.listPlanParts(plan.id).find((p) => p.slug === body.slug);
      if (!part) return reply.code(404).send({ error: `plan ${params.id} has no part "${body.slug}"` });
      const criteria = acceptanceCriteria(part);
      if (!criteria.some((c) => c.text === body.criterion))
        return reply.code(409).send({ error: 'that criterion is not one this part declares' });
      const next = body.met
        ? [...part.acceptanceMet.filter((c) => c !== body.criterion), body.criterion]
        : part.acceptanceMet.filter((c) => c !== body.criterion);
      const updated = store.plans.setPartAcceptanceMet(part.id, next);
      hub.broadcast({ type: 'world:changed' });
      return { ok: true, part: updated };
    }),
  );

  const PartProfileBody = z.object({
    slug: requiredText('slug is required — the part being pinned'),
    profile: optionalText('profile'),
  });
  app.post(
    '/api/plans/:id/part-profile',
    checked({ params: IdParams, body: PartProfileBody }, async ({ params, body, reply }) => {
      const plan = store.plans.getPlan(params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const part = store.plans.listPlanParts(plan.id).find((p) => p.slug === body.slug);
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
      const updated = store.plans.setPartProfile(part.id, wanted);
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, part: updated };
    }),
  );

  const RegroupBody = z.object({
    groups: z
      .array(
        z.object({
          slug: requiredText('every group needs the slug of the part it is'),
          atoms: z.array(z.string().min(1), { invalid_type_error: 'atoms must be a list of atom slugs' }).default([]),
          title: optionalText('title'),
          scope: optionalText('scope'),
        }),
        {
          required_error: 'groups is required — one entry per part, saying which atoms it carries',
          invalid_type_error: 'groups must be a list — one entry per part, saying which atoms it carries',
        },
      )
      .min(1, 'a regrouped plan still needs at least one part'),
  });
  app.post(
    '/api/plans/:id/regroup',
    checked({ params: IdParams, body: RegroupBody }, async ({ params, body, reply }) => {
      const plan = store.plans.getPlan(params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const regrouped = regroupedDocument({
        plan,
        parts: store.plans.listPlanParts(plan.id),
        atoms: store.plans.listAllPlanAtoms().filter((a) => a.planId === plan.id),
        groups: body.groups,
      });
      if (!regrouped.ok) return reply.code(400).send({ error: regrouped.error });

      const result = amendPlanInPlace(
        { store, proposals },
        plan,
        regrouped.document,
        'superseded by a regroup in the cockpit',
      );
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return {
        ok: true,
        detail:
          `The plan for ${plan.originRef} is regrouped into ${regrouped.document.parts.length} part(s) and is ` +
          'waiting on your approval. Nothing is scheduled until you give it.',
        retired: result.retired,
      };
    }),
  );

  const RestartPartBody = z.object({ slug: requiredText('slug is required — the part being restarted') });
  app.post(
    '/api/plans/:id/restart-part',
    checked({ params: IdParams, body: RestartPartBody }, async ({ params, body, reply }) => {
      const plan = store.plans.getPlan(params.id);
      if (!plan) return reply.code(404).send({ error: 'plan not found' });
      const part = store.plans.listPlanParts(plan.id).find((p) => p.slug === body.slug);
      if (!part) return reply.code(404).send({ error: `plan ${params.id} has no part "${body.slug}"` });
      const issueNumber = planIssueNumber(plan.originRef);
      if (issueNumber === null)
        return reply.code(400).send({ error: `${plan.originRef} names no issue, so its parts have no branch to drop` });
      const refusal = partRestartRefusal(part, store.tasks.listTasks(), system.connector.canClosePr());
      if (refusal !== null) return reply.code(400).send({ error: refusal });

      const done = await restartPlanPart(
        { store, sink: system.connector, worktrees: system.worktrees, errors: system.errors },
        part,
        issueNumber,
      );
      if (!done.ok) return reply.code(400).send({ error: done.error });
      hub.broadcast({ type: 'world:changed' });
      await harness.runCycle('manual');
      return { ok: true, part: done.part, detail: done.detail };
    }),
  );
}

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
        : proposedPlanDiff(store.plans.listPlanRevisions(amendment.planId), {
            narrative: declared.narrative,
            parts: declared.parts,
          }),
    warnings: declared === null ? [] : amendmentWarnings(store.plans.listPlanParts(amendment.planId), declared.parts),
  };
}

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
