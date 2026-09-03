import type { Issue, PlanPart, PullRequest } from '../types.js';
import { issueBranch } from '../dispatcher/issuePickup.js';
import { liveParts, partBranch, partSettled } from './parts.js';

/**
 * A plan that cannot proceed, and what the harness says about it.
 *
 * ## The gap this closes
 *
 * The ref-collision guard is correct and complete: `refs/heads/issue/12` blocks
 * every `refs/heads/issue/12/<slug>`, so the reconciler parks the parts `blocked`
 * and says so. What it does not do is *reach anyone*. The Errors panel is a feed,
 * and a feed carries news; the plan's own status comment reports progress, and a
 * plan with no progress reports none. So an issue picked up unplanned first, then
 * planned and approved onto its own taken branch, had red assemblers, no agent, no
 * question in "Needs you", and no route out.
 *
 * Two separate things were missing and they are kept separate here: a way to
 * *notice* ({@link planIsWedged}) and a way to *warn before it happens* — the
 * approval caveats in `src/plans/planCaveats.ts`, which both of the readings below
 * feed. The way out is Replan, on the plan sheet, which
 * is the way out of every plan that is wrong for any other reason too.
 *
 * ## What is deliberately not here
 *
 * **Nothing attaches the existing pull request to a part.** A PR on the flat
 * `issue/<n>` branch claims to resolve the whole issue, and nothing in the harness
 * knows which part, if any, it satisfies. Deriving that would be inferring a
 * positive terminal from incidental evidence, refused at every other point in this
 * codebase (`undeclared` vs `more_work`, the DONE sentinel vs the `result` event,
 * `conclude_part` refusing `kind: 'code'`). The PR is *named* to the operator and
 * left alone.
 */

/** A live part that is doing something, or about to. Its plan is not wedged. */
function isMoving(part: PlanPart): boolean {
  return part.status === 'ready' || part.status === 'dispatched' || part.status === 'in_review';
}

/**
 * Is this plan going nowhere — something blocked, and nothing moving?
 *
 * **It used to read "every live part is blocked", and that stopped being true when
 * the declined human step became the second thing that blocks a part.** A
 * collision blocks the parts *together*; a decline blocks *one*. The old reading
 * got each wrong in the opposite direction: it escalated a plan whose only part
 * was a step the operator had just refused, and it missed a genuine wedge the
 * moment one sibling had merged, because a settled part is not a blocked one and
 * `every` then said no. That second case is a goal stalled for good with nothing
 * in "Needs you" — `plan-part` finds no `ready` part, `rollUpPlanStatus` keeps the
 * plan `active` so `issue-assess` skips it, and the route stays `parts` so
 * `issue-pickup` skips it too.
 *
 * So it judges **movement**, not blocked-ness. A `ready` part is moving even when
 * it is a *human* part: the bench is where that one is visible, and
 * [05](docs/spec/05-dispatcher.md) is deliberate that a human part is not "queued
 * and held".
 *
 * **A decline alone is not a wedge**, which is the other half. Specs
 * [08](docs/spec/08-planning.md) and [13](docs/spec/13-jobs-and-tickets.md) both
 * state that nothing escalates for a decline — the operator is the one who
 * declined, and the button is in front of them — so a plan whose live parts are
 * all declined steps asks nobody anything. What those specs do not cover, and
 * what this does, is a decline that **strands** work: `[merged, declined, pending]`
 * leaves a part nobody refused waiting on one somebody did, forever, and that is
 * the failure `plan-blocked` exists to close. The stranded part is what makes it a
 * question; {@link wedgedPlanPrompt} then words it for the blocker that is actually
 * there.
 *
 * A part blocked on a database from before `blockedBy` existed is unattributed and
 * counts, which is the pre-column behaviour and the direction that keeps a real
 * collision escalating.
 *
 * A plan with no live parts is not wedged but empty, which is a different thing
 * and is left to say so itself.
 */
export function planIsWedged(parts: PlanPart[]): boolean {
  const live = liveParts(parts);
  if (live.length === 0) return false;
  if (!live.some((p) => p.status === 'blocked')) return false;
  if (live.some(isMoving)) return false;
  // Nothing is moving and something is blocked. It is a question only if something
  // is actually stuck behind it: a part that is neither settled (`liveParts` keeps
  // merged and concluded rows, which is why this is not `live` again) nor the
  // operator's own refusal. That leaves work waiting on one, or a blocker —
  // the collision — that clearing a branch would release.
  return live.some((p) => !partSettled(p) && (p.status !== 'blocked' || p.blockedBy !== 'declined'));
}

/**
 * The reason the parts carry, for quoting back.
 *
 * Read off the row rather than recomposed, so the escalation, the Goal Floor's
 * plate and the Errors panel are one sentence — `refCollisionReason` is written
 * once and read everywhere, and a second rendering here would be the drift that
 * predicate exists to prevent. Null when the rows carry none (an older database),
 * and the caller then says less rather than inventing it.
 *
 * Every blocked part's reason, not the first: a decline names the step it refused,
 * so a plan wedged behind two of them has two sentences and quoting one would drop
 * the other. Deduplicated, because a collision writes the same sentence onto every
 * part it blocks.
 */
export function wedgeReasons(parts: PlanPart[]): string[] {
  const seen = new Set<string>();
  for (const part of liveParts(parts)) if (part.blockedReason) seen.add(part.blockedReason);
  return [...seen];
}

/**
 * Open pull requests for the issue that **no live part claims**.
 *
 * The interesting one is a PR on the flat `issue/<n>` branch, left by an unplanned
 * pickup: it is both the thing that blocks the parts and a real piece of work the
 * operator has open, and once a plan exists it belongs to nothing. `linkedPrNumber` is
 * included because it is the other way a PR is attached to an issue, and excluded
 * again when a part has claimed it — which is the ordinary case for a plan that is
 * working, where the sticky link points at whichever part opened last.
 */
export function unclaimedIssuePrs(issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): PullRequest[] {
  const flat = issueBranch(issue.number);
  const live = liveParts(parts);
  const claimed = (pr: PullRequest): boolean =>
    live.some((p) => p.prNumber === pr.number || pr.branch === (p.branch ?? partBranch(issue.number, p.slug)));
  return openPrs.filter(
    (pr) => !pr.merged && !claimed(pr) && (pr.branch === flat || pr.number === issue.linkedPrNumber),
  );
}

/**
 * The question put to a human once a released plan turns out to be going nowhere.
 *
 * It names the unclaimed pull request too, and for the reason the whole escalation
 * exists: the approval caveats already said it, but approval can be days
 * behind the moment the operator is standing in front of the wedge, and "clear
 * what is blocking the parts" is unfollowable while a PR holds the branch open.
 * The one thing that is not said is which part the PR belongs to — see the header:
 * nothing here knows, and it is named and left alone.
 */
export function wedgedPlanPrompt(issueNumber: number, issue: Issue, parts: PlanPart[], openPrs: PullRequest[]): string {
  const live = liveParts(parts);
  // What is left to do: `liveParts` keeps merged and concluded rows, and counting a
  // part that is finished among the ones that are stuck would be false in the
  // sentence an operator reads first.
  const outstanding = live.filter((p) => !partSettled(p));
  const blocked = outstanding.filter((p) => p.status === 'blocked');
  // Which blocker is actually there decides both halves of the wording. A decline
  // is not something "clearing" reaches, and a plan wedged behind one has parts
  // that are *waiting* rather than blocked — saying every part is blocked would be
  // false about the ones that are merely stranded.
  const clearable = blocked.some((p) => p.blockedBy !== 'declined');
  const stranded = outstanding.filter((p) => p.status !== 'blocked');
  const prs = unclaimedIssuePrs(issue, parts, openPrs).map(
    (pr) =>
      `\n\nPR #${pr.number} ("${pr.title}") is open on ${pr.branch} and belongs to no part of this plan. While it ` +
      `is open the branch cannot be deleted, so it has to be merged or abandoned first — and nothing here knows ` +
      `which part, if any, it satisfies.`,
  );
  const shape =
    stranded.length === 0
      ? `every one of its parts is blocked`
      : `${blocked.length} of its ${outstanding.length} unfinished parts ` +
        `${blocked.length === 1 ? 'is' : 'are'} blocked and nothing else is moving`;
  const wayOut = clearable
    ? `\n\nTwo ways out, and the harness will not choose between them: clear what is blocking the parts and they ` +
      `start on the next pulse, or Replan from the plan sheet and let a planner cut the work somewhere the branch ` +
      `is free.`
    : `\n\nThere is no branch to clear here — the block is a step you declined, and declining it was a decision, ` +
      `not a fault. The way out is Replan from the plan sheet, cutting the work so nothing depends on the step ` +
      `you refused, or abandoning the decomposition to work the issue whole.`;
  return (
    `The approved ${live.length}-part plan for issue #${issueNumber} ("${issue.title}") is not running: ${shape}, ` +
    `so no agent has been dispatched and none will be.` +
    wedgeReasons(parts)
      .map((r) => ` ${r}`)
      .join('') +
    prs.join('') +
    wayOut
  );
}
