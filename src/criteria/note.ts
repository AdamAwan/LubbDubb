import type { GoalCriteriaVersion } from '../types.js';

// → docs/spec/08-planning.md#what-the-fleet-is-handed

export function goalCriteriaNote(version: GoalCriteriaVersion | null | undefined): string {
  if (!version) return '';
  return (
    `\n\n---\n\n**What "done" means for this goal**, as the operator wrote it (version ${version.version}):\n\n` +
    `${version.text.trim()}\n\nThese criteria are the authority on the goal. Where a part's acceptance or your ` +
    `own reading of the ticket disagrees with them, they win — say so in your output rather than quietly ` +
    `following the other.`
  );
}
