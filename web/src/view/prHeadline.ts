// → docs/spec/17-cockpit.md#the-pull-request-card

const GOAL_PREFIX = /^#\d+\s+/;
const STACK_PREFIX = /^\[\d+\/\d+\]\s*/;
const COMMIT_TYPE = /^[a-z]+(?:\([^)]*\))?!?:\s+/i;

/**
 * A pull request's title as a headline: the `#390 [2/3] feat(checkout): ` the fleet writes in front
 * of it taken off — the goal heading, the stack and the card already say each of those — and the
 * first letter raised. A title that is nothing but a prefix is left whole.
 */
export function prHeadline(title: string): string {
  const bare = title.replace(GOAL_PREFIX, '').replace(STACK_PREFIX, '').replace(COMMIT_TYPE, '').trim();
  if (bare === '') return title;
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}
