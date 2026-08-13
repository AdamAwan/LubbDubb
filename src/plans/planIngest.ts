import type { Store } from '../store/store.js';
import type { Plan, PlanStatus } from '../types.js';
import type { PlanDocument } from './planDocument.js';
import { planNarrative, planPartInputs } from './planDocument.js';
import {
  amendedPlanStatus,
  partHasWork,
  partIsHuman,
  partOrigin,
  partsToRetire,
  planIssueNumber,
  singleOverruled,
} from './parts.js';

/** What a human task says when the plan that asked for it stopped asking. */
const RETIRED_PART_RESOLUTION = 'An amended plan no longer includes this step.';

/** What an ingestion did, so either caller can report it in its own idiom. */
interface PlanIngestResult {
  plan: Plan;
  status: PlanStatus;
  /** Slugs of parts the amended document dropped, retired because nothing was started for them. */
  retired: string[];
  /**
   * Set when the planner asked for `single` but live parts already carry a branch
   * or an open PR, so the plan stayed split. Not an error — the write succeeded —
   * but the operator needs to know their verdict was not honoured.
   */
  overriddenSingle: { liveParts: number } | null;
}

/**
 * Persist a planning agent's verdict. The **one** place a plan document becomes
 * plan rows, so the `plan.json` side channel and the `plan_submit` MCP tool can
 * never drift into two subtly different writes — the same reason the two PTY
 * sentinel detectors converge on `noteSentinel`.
 *
 * The verdict is stored for *both* outcomes — a `single` plan is a first-class
 * row — because without one the planner re-runs on the same issue every cycle.
 * This is also where a **replan** lands: the merge on slug is what lets an
 * in-flight part keep its branch and PR across an amendment.
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
    /**
     * `planning.requireApproval` — whether a `parts` verdict lands as a proposal
     * (`awaiting_approval`) rather than as work (`active`). Carried in rather than
     * read from a config here because ingestion is deliberately store-only: both
     * transports (the `plan.json` drain and the `plan_submit` tool) pass their own
     * operator's policy, so neither can persist a verdict the other wouldn't.
     */
    requireApproval?: boolean;
  },
): PlanIngestResult {
  const { doc, originRef, title } = input;
  // An *amended* plan is the interesting case: `upsertPlanParts` merges on slug
  // and never deletes, so a part the planner dropped would otherwise linger,
  // indistinguishable from one still to come. Retire the dropped ones that never
  // started; the plan status then follows what survived, because a `single`
  // verdict cannot un-split an issue whose parts already have branches and PRs.
  const existingPlan = store.getPlanByOrigin(originRef);
  const existing = existingPlan ? store.listPlanParts(existingPlan.id) : [];
  const declared = doc.verdict === 'parts' ? planPartInputs(doc) : [];
  const retire = partsToRetire(
    existing,
    declared.map((p) => p.slug),
  );
  const retiring = new Set(retire.map((p) => p.id));
  const surviving = existing.filter((p) => !retiring.has(p.id));
  const status = amendedPlanStatus(doc.verdict, surviving, input.requireApproval ?? false);

  const narrative = planNarrative(doc);
  const plan = store.upsertPlan({ originRef, title, status, ...narrative });
  // The verdict as submitted, kept beside the row it overwrote. Written here
  // rather than in either transport because this is the one place a document
  // becomes rows: a revision cannot then exist for a verdict that was never
  // persisted, or be missing for one that was.
  store.recordPlanRevision(plan.id, { verdict: doc.verdict, narrative, parts: declared });
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  // A retired part's ask is withdrawn with it. Declined rather than deleted or a
  // third terminal of its own: "this is not going to be done, and here is why" is
  // exactly what declining means, and the alternative — an open task pointing at a
  // part no plan schedules — is an obligation on the operator that nothing will
  // ever settle.
  for (const task of store.listHumanTasksForParts(retire.map((p) => p.id))) {
    if (task.status === 'open') store.settleHumanTask(task.id, 'declined', RETIRED_PART_RESOLUTION);
  }
  const written = declared.length > 0 ? store.upsertPlanParts(plan.id, declared) : [];
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

  // An amended plan is what *ends* a discussion — the agent has said its piece and
  // submitted. Cleared here rather than in the route so it holds for both
  // transports, and so an agent that finishes without anyone pressing a button
  // still leaves the plan in a state rule `issue-plan` will not re-dispatch from.
  if (plan.discussing) store.setPlanDiscussing(plan.id, false);

  return {
    plan,
    status,
    retired: retire.map((p) => p.slug),
    // Asked of the parts, never of the status: an honoured single verdict is
    // `active` too (the shape is the empty part list), and `awaiting_approval` is
    // the verdict honoured and gated. Reading either as an override would tell the
    // planner and the operator its verdict was refused by the world when it was
    // not.
    overriddenSingle: singleOverruled(doc.verdict, surviving)
      ? { liveParts: surviving.filter(partHasWork).length }
      : null,
  };
}

/** The operator-facing explanation for an overridden `single` verdict. Pure. */
export function overriddenSingleMessage(originRef: string, liveParts: number): string {
  return (
    `Issue ${originRef} was replanned as a single PR, but ${liveParts} part(s) already have a branch ` +
    `or an open PR. The plan stays split — close or merge those parts first.`
  );
}
