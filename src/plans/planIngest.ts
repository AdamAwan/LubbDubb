import type { Store } from '../store/store.js';
import type { Plan, PlanStatus } from '../types.js';
import type { PlanDocument } from './planDocument.js';
import { planNarrative, planPartInputs } from './planDocument.js';
import { validationCheckInputs, validationResourceInputs } from '../validation/checkDocument.js';
import { watchSignalInputs } from '../validation/watchDocument.js';
import { withdrawResourceAsks } from '../validation/ask.js';
import { partIsHuman, partOrigin, partsToRetire, planIssueNumber } from './parts.js';
import { AMENDED_PART_RESOLUTION, withdrawPartAsks } from './partAsks.js';

/** What a human task says when the plan that asked for it stopped asking. */

/** The same settlement, one layer down: a check an amended plan stopped declaring. */
const SUPERSEDED_CHECK_REASON = 'An amended plan no longer includes this check.';

/**
 * What the band on an amended check says when the amendment came from a replan
 * rather than from an agent's correction.
 *
 * Deliberately not the plan's own `reason`: that field is about the *shape* of the
 * work — why this split rather than another — and an operator reading "three parts
 * keeps the migration reviewable" over a check whose expectation just changed
 * would be told nothing about the check. Saying only what is certainly true is
 * better than borrowing a sentence written about something else.
 */
const AMENDED_CHECK_NOTE = 'A replan changed this check. Re-read it before you rely on the result you had.';

/** What an ingestion did, so either caller can report it in its own idiom. */
interface PlanIngestResult {
  plan: Plan;
  status: PlanStatus;
  /** Slugs of parts the amended document dropped, retired because nothing was started for them. */
  retired: string[];
}

/**
 * Persist a planning agent's plan. The **one** place a plan document becomes plan
 * rows, so the `plan.json` side channel and the `plan_submit` MCP tool can never
 * drift into two subtly different writes — the same reason the two PTY sentinel
 * detectors converge on `noteSentinel`.
 *
 * Every plan writes parts, because every plan *has* parts: the document schema
 * refuses one with none, so there is no second write path here for the plan that
 * happens to be one pull request. This is also where a **replan** lands: the merge
 * on slug is what lets an in-flight part keep its branch and PR across an
 * amendment.
 *
 * Callers are expected to have validated `doc` at their own boundary; this takes
 * a parsed document precisely so validation failures can be reported differently
 * (silently retried for the file path, returned to the agent for the tool path).
 */
export function ingestPlanDocument(
  store: Store,
  input: {
    doc: PlanDocument;
    originRef: string;
    title: string;
  },
): PlanIngestResult {
  const { doc, originRef, title } = input;
  // An *amended* plan is the interesting case: `upsertPlanParts` merges on slug
  // and never deletes, so a part the planner dropped would otherwise linger,
  // indistinguishable from one still to come. Retire the dropped ones that never
  // started.
  const existingPlan = store.getPlanByOrigin(originRef);
  const existing = existingPlan ? store.listPlanParts(existingPlan.id) : [];
  const declared = planPartInputs(doc);
  const retire = partsToRetire(
    existing,
    declared.map((p) => p.slug),
  );
  // Every plan lands as a proposal, whatever its size and whichever transport
  // wrote it: the status *is* the gate, so releasing it is a one-way transition on
  // this row rather than a policy re-read every pulse. Both transports (the
  // `plan.json` drain and `plan_submit`) reach this one function precisely so
  // neither can persist a verdict the other wouldn't.
  const status: PlanStatus = 'awaiting_approval';

  const narrative = planNarrative(doc);
  const plan = store.upsertPlan({ originRef, title, status, ...narrative });
  // The plan as submitted, kept beside the row it overwrote. Written here rather
  // than in either transport because this is the one place a document becomes
  // rows: a revision cannot then exist for a plan that was never persisted, or be
  // missing for one that was.
  store.recordPlanRevision(plan.id, { narrative, parts: declared });
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  withdrawPartAsks(store, retire, AMENDED_PART_RESOLUTION);
  const written = store.upsertPlanParts(plan.id, declared);
  // Back each declared human step with a `human_tasks` row. `recordHumanTask`
  // refreshes on a repeat rather than inserting, so a replan that re-declares the
  // same step does not file the ask twice — and one that re-declares a step the
  // operator already settled leaves that settlement standing, which is the same
  // discipline `upsertPlanParts` applies to a part's own progress.
  const issueNumber = planIssueNumber(originRef);
  for (const part of written.filter(partIsHuman)) {
    store.recordHumanTask({
      title: part.title,
      detail: part.acceptance ?? part.scope,
      // The part's own origin, so the panel row links to the work it belongs to
      // through the same `refUrls` fold as everything else. Null on the one path
      // that has no issue behind it, which no planner reaches.
      originRef: issueNumber === null ? null : partOrigin(issueNumber, part.slug),
      partId: part.id,
      agentId: null,
      taskId: null,
    });
  }

  // The validation plan, folded on the same terms as the parts: merged on the
  // check id, letters assigned once, and a check the amendment stopped declaring
  // superseded rather than deleted. Written here rather than in either transport
  // for the reason the revision is — this is the one place a document becomes
  // rows, so the two transports cannot ingest subtly different check sets.
  //
  // `doc.validation` absent leaves existing checks exactly as they are, which is
  // the only honest reading: an operator override that never learned the block
  // produces plans without one, and treating that as "the planner withdrew every
  // check" would supersede a validation plan somebody is halfway through.
  if (doc.validation) {
    const resources = validationResourceInputs(doc.validation.resources);
    // Before the write, because the ask is reached through the resource row this
    // is about to replace. A document speaks for the *whole* resource list, so
    // what it does not declare it has withdrawn — and an ask nothing withdraws is
    // an obligation on the operator that nothing can ever settle, the retired
    // part's failure one layer down.
    //
    // The ask itself is filed by `ValidationAskDesk`, once the goal is delivered
    // and a check is something anybody can run.
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

  // The post-deploy watch, on the same terms as the validation plan one field
  // above: merged on the author's own slug, written here rather than in either
  // transport so the two cannot ingest subtly different check sets, and *absent*
  // leaves the existing checks exactly as they are — an operator override that
  // never learned the block produces plans without one, and reading that as "the
  // planner withdrew every check" would drop a watch somebody is relying on.
  //
  // Nothing is asked of an environment here. The dry run is the caller's, because
  // only a caller can hand its refusal back to the author.
  if (doc.watch) store.ingestGoalWatch(originRef, watchSignalInputs(doc.watch));

  return { plan, status, retired: retire.map((p) => p.slug) };
}
