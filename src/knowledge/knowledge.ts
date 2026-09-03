/**
 * What survives of the fleet-wide claim store: one reading of a dispatch origin.
 *
 * The store itself — its facts, its corroboration and contradiction, its notices,
 * its graduations and the page an operator ruled on them from — is gone, replaced
 * by the obstacle board (`docs/spec/27-obstacles.md`). This function is the one
 * piece the board leans on, and it is kept here rather than copied because two
 * spellings of *which goal said this* is two things to be wrong about.
 */

/**
 * The **goal** one observation was made on, collapsed from the dispatch origin —
 * `pr:412:ci` and `pr:412:comments` are two origins and one goal.
 *
 * This is the whole of "different goals, not different origins": two parts of one
 * goal hitting one wall is one observation, and counting the origins would carry a
 * row to `standing` on the strength of one agent's two dispatches.
 *
 * Null for an origin naming no goal at all (an operator's job), which the count
 * treats as its own voice rather than as a shared one.
 *
 * → `docs/spec/27-obstacles.md#states`
 */
export function corroborationGoal(originRef: string | null): string | null {
  const match = /^(issue|pr|job):([^:]+)(?::|$)/.exec(originRef ?? '');
  return match ? `${match[1]}:${match[2]}` : null;
}
