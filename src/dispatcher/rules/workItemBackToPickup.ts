import { openPrForIssue } from '../issuePickup.js';
import { resolveIssueConclusion } from '../../issueConclusion.js';
import { issueOrigin } from '../../plans/planning.js';
import type { RawAction, StageContext } from './context.js';

/**
 * The inverse of the back-off: return an item parked in the review state to the
 * *first* pickup state — but **only on an explicit `more_work` verdict**, never on
 * the mere absence of a PR.
 *
 * That used to be the other way round, and it was the bug: `openPrForIssue` reads
 * only the open list, so "this PR merged" and "there was never a PR" are one
 * observation, and a merged PR bounced its ticket back to "Ready" for
 * `issue-pickup` to put a fresh agent on work already on the default branch. A
 * review state does not distinguish "waiting on test" from "still has work in it",
 * so the harness now stops on silence and says so, rather than guessing (see
 * `src/issueConclusion.ts`).
 *
 * A decomposed issue needs no special case: an in-flight plan resolves to
 * `more_work` through the roll-up and a complete one to `done`, which is the same
 * behaviour the explicit `decomposed` check used to give it.
 */
export function workItemBackToPickup(s: StageContext): void {
  if (!s.workItemStates) return;
  const { inReviewState, pickupStates } = s.workItemStates;
  // No separate config for where an item returns to: the first pickup state is
  // the operator's own "start here" (e.g. "Ready" in ["Ready","Doing"]).
  const returnState = pickupStates[0]!;
  for (const issue of s.ctx.world.issues) {
    // Returning a retained run to a pickup state would put work back in front of
    // the fleet for a goal whose run the operator has not ended — the inverse of
    // what the union is for (issue #234). Explicit, for `work-item-in-review`'s reason.
    if (s.retained.has(issue.number)) continue;
    const state = issue.workItemState;
    if (state === undefined || issue.state !== 'open') continue;
    // The back-off arm owns an item in a pickup state, whatever else is true of
    // it — preserving the `else if` these two used to share.
    if (pickupStates.includes(state)) continue;
    if (state !== inReviewState) continue;
    if (openPrForIssue(issue, s.openPrs)) continue;
    // The one question that decides it: did whoever owns this issue say
    // there is more to do? A plan says so by having parts in flight, an
    // agent by calling `conclude_work`. `done` and `undeclared` both leave
    // the item where it is — the first because it is finished, the second
    // because nobody vouched for it and re-doing merged work is the more
    // expensive mistake than waiting for a human to look.
    const plan = s.plansByOrigin.get(issueOrigin(issue.number)) ?? null;
    const conclusion = resolveIssueConclusion(
      s.conclusions.get(issueOrigin(issue.number)) ?? null,
      plan,
      plan ? (s.ctx.planParts ?? []).filter((p) => p.planId === plan.id) : [],
      s.shortfallsByOrigin.get(issueOrigin(issue.number)) ?? null,
    );
    if (conclusion.verdict !== 'more_work') continue;
    s.raw.push({
      type: 'set_work_item_state',
      number: issue.number,
      state: returnState,
      rule: 'work-item-back-to-pickup',
      reason:
        `Work item #${issue.number} is open in "${inReviewState}" with no open PR, and ` +
        `${
          conclusion.by === 'plan'
            ? conclusion.note
            : conclusion.by === 'assessor'
              ? 'an assessment of the delivered work found the goal is not reached'
              : `${conclusion.by === 'operator' ? 'you' : 'the agent that worked it'} reported work outstanding`
        }` +
        `; move it back to "${returnState}" so the rest can be picked up.`,
    } satisfies RawAction);
  }
}
