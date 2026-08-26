/**
 * Which model profile one dispatch is pinned to, resolved from the origin it is
 * dispatched on (issue #342).
 *
 * `agentModels.byRule` prices work by *kind*, which is right for the fleet and
 * has no answer for the ticket that is harder than the rule it arrived on. The
 * pin is that answer, and it is keyed on the **origin** rather than on the run:
 * a pure function of the dispatch, so a retry runs the same profile, a
 * re-dispatch resolves the same one, and a resumed agent re-launches on what its
 * task row stored. Escalating on attempt count would break all three and is a
 * separate argument.
 *
 * Two levels, and they are different objects rather than two spellings of one:
 * the **goal** carries a tag on its ticket, which is a statement a human can see
 * and take off; a **part** carries a profile on its plan row, which is the
 * planner sizing work it has just decomposed and named acceptance criteria for.
 * A part with none inherits its goal's, so the common case is one decision.
 */

import { issueOriginRole } from './issueOrigins.js';

/** Where a pin is read from, once per cycle. */
interface PinLookup {
  /** The profile tagged on `issue:<n>`'s ticket, or null for none. */
  goal: (issueNumber: number) => string | null;
  /** The profile this goal's plan named for one part, or null when it named none. */
  part: (issueNumber: number, slug: string) => string | null;
}

/**
 * The origins that run on their rule's entry whatever the goal is pinned to.
 *
 * `retro` because a retrospective **gates nothing**: it is one desk agent writing
 * up a goal that has already shipped, and inheriting a deep pin would spend real
 * money on a document no dispatch reads. This is the one place the funnel-wide
 * reading of a pin was rejected outright rather than given a floor, and it is a
 * deliberate special case rather than an oversight — an operator who wants
 * write-ups deeper moves `issue-retro` in `byRule`, where the decision is about
 * the *kind* of work and so belongs.
 *
 * `appraisal` because it is the stage that **produces** the answer. It runs before
 * any proposal exists, so a pin could only reach it on a second pass, and an
 * appraiser whose own depth moved with the pin it proposes would be grading its own
 * work.
 */
const UNPINNED_SUFFIXES = ['retro', 'appraisal'];

/**
 * The profile this dispatch is pinned to, or null to leave it to the rule.
 *
 * Null for every origin outside the `issue:<n>` subtree, which is where v1 stops:
 * a pull request opened by a part agent is dispatched on `pr:<n>`, so the CI and
 * review rules resolve on `byRule` regardless of what the goal behind them is
 * pinned to. Following a pin down that lineage is a second mechanism — the PR
 * would have to be traced back through the plan that produced it — and it is not
 * this one.
 */
export function pinnedProfileFor(originRef: string | null, lookup: PinLookup): string | null {
  const match = /^issue:(\d+)(?::(.+))?$/.exec(originRef ?? '');
  if (!match) return null;
  const issueNumber = Number(match[1]);
  const suffix = match[2] ?? null;
  if (suffix !== null && UNPINNED_SUFFIXES.includes(suffix)) return null;

  // A part's own profile first, then the goal's — the planner knew which part was
  // the hard one, and the operator knew the ticket was hard. Neither reading is
  // stale, so the narrower one wins.
  const part = suffix?.startsWith('part:') === true ? lookup.part(issueNumber, suffix.slice('part:'.length)) : null;
  if (part !== null) return part;
  // An origin nobody has classified reaches here as `unrecognised` and gets the
  // goal's pin, which is the same answer the work itself gets. Named rather than
  // implied, because `issueOriginRole` exists precisely so that the next origin
  // added has to be decided rather than defaulted: if a new one should run on its
  // rule alone, it belongs in `UNPINNED_SUFFIXES` above.
  return issueOriginRole(issueNumber, originRef) === null ? null : lookup.goal(issueNumber);
}
