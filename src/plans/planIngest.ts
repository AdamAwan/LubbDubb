import type { Store } from '../store/store.js';
import type { Plan, PlanStatus } from '../types.js';
import type { PlanDocument } from './planDocument.js';
import { planPartInputs } from './planDocument.js';
import { amendedPlanStatus, partHasWork, partsToRetire } from './parts.js';

/** What an ingestion did, so either caller can report it in its own idiom. */
export interface PlanIngestResult {
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

  const plan = store.upsertPlan({ originRef, title, status, reason: doc.reason });
  for (const part of retire) store.updatePlanPart(part.id, { status: 'retired' });
  if (declared.length > 0) store.upsertPlanParts(plan.id, declared);

  return {
    plan,
    status,
    retired: retire.map((p) => p.slug),
    overriddenSingle:
      doc.verdict === 'single' && status !== 'single' ? { liveParts: surviving.filter(partHasWork).length } : null,
  };
}

/** The operator-facing explanation for an overridden `single` verdict. Pure. */
export function overriddenSingleMessage(originRef: string, liveParts: number): string {
  return (
    `Issue ${originRef} was replanned as a single PR, but ${liveParts} part(s) already have a branch ` +
    `or an open PR. The plan stays split — close or merge those parts first.`
  );
}
