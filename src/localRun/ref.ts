import type { PlanPart } from '../types.js';

/**
 * One branch a goal may be run at.
 *
 * `part` is null for the goal's **own** branch — the single pull request a goal
 * worked without a decomposition has. Those goals are the common simple case and
 * were the one this feature originally could not see at all: no plan parts meant no
 * candidate branch, so a goal with an open PR in front of you resolved to the
 * integration branch and said nothing about it.
 *
 * A part's status rides along because it is the label the panel needs and not a
 * thing it should work out: a merged part's branch is a legitimate thing to look at
 * (it shows the state that part delivered) and a misleading one to offer unlabelled.
 */
export interface LocalRunOption {
  /** The branch. Never empty — a part without one is not an option. */
  ref: string;
  part: { slug: string; title: string; seq: number; status: PlanPart['status'] } | null;
}

/** What a goal can be run at: the default, everything else on offer, and the shape of the plan. */
export interface LocalRunChoices {
  /**
   * The ref a start with no override uses — the tip of the stack, the goal's own
   * branch, or **null** for the integration branch.
   */
  target: string | null;
  /**
   * Every branch this goal may be run at: its own first, then its parts in plan
   * order.
   *
   * This is the **allow-list**, not just a list to draw: an override is checked
   * against it, so the panel is a way to run this goal's own work and never a way to
   * check out an arbitrary ref.
   */
  options: LocalRunOption[];
  /** How much of the plan there is, and how much of it is already in the integration branch. */
  parts: { total: number; merged: number };
}

/** Statuses whose branch is not worth defaulting to — see {@link localRunChoices}. */
function skippable(status: PlanPart['status']): boolean {
  // `merged` is in the integration branch already, so its branch shows an older
  // state than the goal delivered. `retired` was dropped by an amendment and
  // `concluded` produced a report rather than code — neither has code to look at,
  // and both can still carry a branch from before they got there, which is exactly
  // the stale checkout this skips.
  return status === 'merged' || status === 'retired' || status === 'concluded';
}

/**
 * What a goal's local run can check out, and which of those it does by default.
 *
 * **The default is the furthest-along part with a branch — the tip of the stack.**
 * Plan order *is* stacking order: a part is cut from its predecessor's branch, so
 * the last unmerged one contains everything behind it, and that is what somebody
 * asking to see a goal means. Running the *first* unmerged part instead — the
 * original rule here — showed the least of the goal's work, and showed it silently:
 * the environment came up on a real branch of that goal, one section behind whatever
 * was being looked for.
 *
 * `own` is the goal's **own** branch, from its open pull request — the whole answer
 * for a goal nobody decomposed. It ranks below the plan's tip, because a goal that
 * has been decomposed has its current work on its parts.
 *
 * With neither, null: a goal whose parts have all merged **is** the integration
 * branch, and so is one nothing has started.
 *
 * One function rather than a rule and a list beside it, because three callers need
 * it — the runner's default, the runner's guard on an override, and the snapshot the
 * panel draws — and two implementations of "which one is the tip" would be free to
 * disagree about the branch an operator is looking at.
 *
 * Pure, and separate from the runner, because it is the one decision in the feature
 * with more than one defensible answer: worth a test of its own rather than three
 * lines inside a method that also spawns a process.
 */
export function localRunChoices(parts: readonly PlanPart[], own: string | null = null): LocalRunChoices {
  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  const options: LocalRunOption[] = own === null ? [] : [{ ref: own, part: null }];
  let tip: string | null = null;
  for (const part of ordered) {
    if (part.branch === null || part.branch === '') continue;
    options.push({
      ref: part.branch,
      part: { slug: part.slug, title: part.title, seq: part.seq, status: part.status },
    });
    // Last one wins: the parts are in plan order, so this leaves the furthest-along
    // runnable branch standing.
    if (!skippable(part.status)) tip = part.branch;
  }
  return {
    target: tip ?? own,
    options,
    parts: { total: ordered.length, merged: ordered.filter((p) => p.status === 'merged').length },
  };
}
