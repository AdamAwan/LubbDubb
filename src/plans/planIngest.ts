import type { Store } from '../store/store.js';
import type { Plan, PlanStatus } from '../types.js';
import type { PlanDocument } from './planDocument.js';
import { planNarrative, planPartInputs } from './planDocument.js';
import { validationCheckInputs, validationResourceInputs } from '../validation/checkDocument.js';
import { watchCheckInputs } from '../validation/watchDocument.js';
import { withdrawResourceAsks } from '../validation/ask.js';
import { partIsHuman, partOrigin, partsToRetire, planIssueNumber } from './parts.js';
import { AMENDED_PART_RESOLUTION, withdrawPartAsks } from './partAsks.js';

// → docs/spec/08-planning.md

const SUPERSEDED_CHECK_REASON = 'An amended plan no longer includes this check.';

const AMENDED_CHECK_NOTE = 'A replan changed this check. Re-read it before you rely on the result you had.';

interface PlanIngestResult {
  plan: Plan;
  status: PlanStatus;
  retired: string[];
}

export function ingestPlanDocument(
  store: Store,
  input: {
    doc: PlanDocument;
    originRef: string;
    title: string;
    approved?: boolean;
  },
): PlanIngestResult {
  const { doc, originRef, title } = input;
  const existingPlan = store.getPlanByOrigin(originRef);
  const existing = existingPlan ? store.listPlanParts(existingPlan.id) : [];
  const declared = planPartInputs(doc);
  const retire = partsToRetire(
    existing,
    declared.map((p) => p.slug),
  );
  const status: PlanStatus = input.approved === true ? 'active' : 'awaiting_approval';

  const narrative = planNarrative(doc);
  const plan = store.upsertPlan({ originRef, title, status, ...narrative });
  store.recordPlanRevision(plan.id, { narrative, parts: declared });
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  withdrawPartAsks(store, retire, AMENDED_PART_RESOLUTION);
  const written = store.upsertPlanParts(plan.id, declared);
  const issueNumber = planIssueNumber(originRef);
  for (const part of written.filter(partIsHuman)) {
    store.recordHumanTask({
      title: part.title,
      detail: part.acceptance ?? part.scope,
      originRef: issueNumber === null ? null : partOrigin(issueNumber, part.slug),
      partId: part.id,
      agentId: null,
      taskId: null,
    });
  }

  if (doc.validation) {
    const resources = validationResourceInputs(doc.validation.resources);
    withdrawResourceAsks(
      store,
      originRef,
      resources.filter((r) => !r.provided).map((r) => r.name),
    );
    store.ingestValidation(originRef, {
      checks: validationCheckInputs(
        doc.validation,
        written.map((p) => p.slug),
      ),
      resources,
      supersededReason: SUPERSEDED_CHECK_REASON,
      amendNote: AMENDED_CHECK_NOTE,
    });
  }

  if (doc.watch) store.ingestGoalWatch(originRef, watchCheckInputs(doc.watch));

  const rolled = input.approved === true ? store.rollUpPlanStatus(plan.id) : null;

  return { plan: rolled ?? plan, status: rolled?.status ?? status, retired: retire.map((p) => p.slug) };
}
