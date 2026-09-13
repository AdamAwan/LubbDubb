import type { Store } from '../store/store.js';
import type { Plan, PlanStatus } from '../types.js';
import type { PlanDocument } from './planDocument.js';
import { planAtomInputs, planNarrative, planPartInputs } from './planDocument.js';
import { declaresCheckSet, validationCheckInputs, validationResourceInputs } from '../validation/checkDocument.js';
import { watchCheckInputs } from '../validation/watchDocument.js';
import { stateQueryInputs } from '../validation/stateDocument.js';
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
  const existingPlan = store.plans.getPlanByOrigin(originRef);
  const existing = existingPlan ? store.plans.listPlanParts(existingPlan.id) : [];
  const declared = planPartInputs(doc);
  const retire = partsToRetire(
    existing,
    declared.map((p) => p.slug),
  );
  const status: PlanStatus = input.approved === true ? 'active' : 'awaiting_approval';

  const narrative = planNarrative(doc);
  const plan = store.plans.upsertPlan({ originRef, title, status, ...narrative });
  store.plans.recordPlanRevision(plan.id, { narrative, parts: declared });
  for (const part of retire) store.plans.updatePlanPart(part.id, { status: 'retired' });
  withdrawPartAsks(store, retire, AMENDED_PART_RESOLUTION);
  store.plans.upsertPlanAtoms(plan.id, planAtomInputs(doc));
  const written = store.plans.upsertPlanParts(plan.id, declared);
  const issueNumber = planIssueNumber(originRef);
  for (const part of written.filter(partIsHuman)) {
    store.humanTasks.recordHumanTask({
      title: part.title,
      detail: part.acceptance ?? part.scope,
      originRef: issueNumber === null ? null : partOrigin(issueNumber, part.slug),
      partId: part.id,
      agentId: null,
      taskId: null,
    });
  }

  if (doc.validation) store.validation.recordValidationHint(originRef, doc.validation.hint ?? null);

  // A `validation` block that declares only a hint writes no check set. Reading a hint-only block as
  // `checks: []` would supersede a check set an operator may be halfway through — the omission rule
  // the whole-set transport is held to. → docs/spec/20-validation.md#amendment
  if (doc.validation && declaresCheckSet(doc.validation)) {
    const resources = validationResourceInputs(doc.validation.resources ?? []);
    withdrawResourceAsks(
      store,
      originRef,
      resources.filter((r) => !r.provided).map((r) => r.name),
    );
    store.validation.ingestValidation(originRef, {
      checks: validationCheckInputs(
        doc.validation,
        written.map((p) => p.slug),
      ),
      resources,
      supersededReason: SUPERSEDED_CHECK_REASON,
      amendNote: AMENDED_CHECK_NOTE,
    });
  }

  if (doc.watch) store.watches.ingestGoalWatch(originRef, watchCheckInputs(doc.watch));

  if (doc.state) store.remoteValidation.saveStateQueries(originRef, stateQueryInputs(doc.state), 'plan');

  const rolled = input.approved === true ? store.plans.rollUpPlanStatus(plan.id) : null;

  return { plan: rolled ?? plan, status: rolled?.status ?? status, retired: retire.map((p) => p.slug) };
}
