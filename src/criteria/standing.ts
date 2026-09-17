import { parseIssueOrigin } from '../issueOrigins.js';
import type { PredictionStore } from '../store/predictions.js';
import type { Store } from '../store/store.js';
import type { CriteriaStanding } from '../types.js';

// → docs/spec/08-planning.md

/**
 * The two timestamps a version's standing is derived against, beside the version's
 * own. Both are nullable, and both nulls mean *has not happened yet* rather than
 * *unknown*: a goal with no reveal row was never offered the gate, and a goal with
 * no part task has had no work dispatched on it.
 */
interface CriteriaAnchors {
  revealedAt: string | null;
  firstPartDispatchAt: string | null;
}

/**
 * A criteria version's standing, derived and never stored.
 *
 * A stored flag is a claim that can be written wrongly once and is then true for
 * ever; this is a comparison of three timestamps the harness already keeps, so a
 * version that was authored before the plan was read cannot later become drift.
 *
 * A goal that was never revealed reads `pre-reveal`, not `post-reveal`: the absence
 * of a reveal row spells *never offered* (the gate may have been off), and calling a
 * version `post-reveal` on a reading that has no timestamp behind it would be
 * inventing the very claim this derivation exists to avoid. Dispatch still outranks
 * it, because a part task is a recorded fact either way.
 */
export function criteriaStanding(input: CriteriaAnchors & { authoredAt: string }): CriteriaStanding {
  const { authoredAt, revealedAt, firstPartDispatchAt } = input;
  if (firstPartDispatchAt !== null && authoredAt >= firstPartDispatchAt) return 'post-work';
  if (revealedAt !== null && authoredAt >= revealedAt) return 'post-reveal';
  return 'pre-reveal';
}

/**
 * What deciding a standing needs, rather than the whole `System`, which satisfies it
 * structurally. `predictions` is deliberately off `Store`
 * (→ docs/spec/14-persistence.md#the-prediction-store-is-not-on-store), so the reveal
 * stamp has to be asked for by name here as it is in `src/server/planReveal.ts`.
 */
interface CriteriaAnchorReader {
  store: Store;
  predictions: PredictionStore;
}

/** The anchors for one goal, read once and handed to every version of its chain. */
export function criteriaAnchors(reader: CriteriaAnchorReader, goalRef: string): CriteriaAnchors {
  return {
    revealedAt: reader.predictions.getReveal(goalRef)?.revealedAt ?? null,
    firstPartDispatchAt: firstPartDispatchAt(reader.store, goalRef),
  };
}

/**
 * When work first went out on this goal's parts, or null for a goal no part has been
 * dispatched on. Every dispatch onto a part is a task at an `issue:<n>:part:<slug>`
 * origin, so the earliest such task's `createdAt` is the moment — a re-dispatch or a
 * crash requeue writes a later row and cannot move it earlier.
 */
function firstPartDispatchAt(store: Store, goalRef: string): string | null {
  let earliest: string | null = null;
  for (const task of store.tasks.listGoalTasks(goalRef, [])) {
    if (parseIssueOrigin(task.originRef)?.family !== 'part') continue;
    if (earliest === null || task.createdAt < earliest) earliest = task.createdAt;
  }
  return earliest;
}
