import type { DeliveryAuthor, Issue, IssueDelivery, WorldEvent } from '../types.js';

/**
 * Whether a standing `delivered` verdict still holds an issue out of pickup.
 *
 * ## What this is
 *
 * `delivered` is the harness's own park. Rule `work-item-in-review` parks a work item in
 * `issueInReviewState` while a PR is open and returns it to pickup only on an
 * explicit `more_work` verdict — but that park is a *tracker state*, so it exists
 * only where the tracker has one. On GitHub there is none, so nothing stops rule `issue-pickup`
 * re-picking an issue the moment its PR leaves the open list, and `openPrForIssue`
 * cannot tell "the PR merged" from "there was never a PR". What bounds that today
 * is the attempt cap: three agents redo merged work, then the origin escalates.
 *
 * This predicate is the park generalised off the tracker and onto a row the
 * harness owns. It is deliberately narrow: it gates **pickup and nothing else**,
 * and it is not a completion test. The terminal answer is the operator's dismissal
 * of the run (issue #234), not this row and not the tracker's `closed` — a close is
 * reporting, and a run outlives it.
 *
 * ## What ends it
 *
 * Two arms, and a third clearer that is deliberately not an arm.
 *
 * The **tracker move** comes first because it is the operator speaking directly,
 * and CLAUDE.md already promises it for conclusions — "moving the ticket in the
 * tracker _is_ the override". It cannot be expressed as a signal: `worldDiff`
 * emits `issue_opened`, `issue_closed` and `issue_linked` and **nothing at all for
 * a `workItemState` transition**, so there is no event to match on. Reading the
 * *current* state rather than a transition is also the sturdier half of the trade
 * — a state survives a restart and a lost baseline, where an event that fell
 * between two pulses does not. Adding an `issue_state` event to `worldDiff` was
 * considered and refused for exactly that reason: it would make the verdict depend
 * on the harness having witnessed the moment of the move, which is the fragility
 * the durable record exists to escape.
 *
 * The **world signal** arm is issue #109 phase 4's rejection expiry, which
 * transfers whole and covers the providers where the first arm can never fire.
 * **Any** transition on the issue counts, strictly after the verdict, for
 * `expiringSignal`'s reason: a per-kind filter here would be a second opinion
 * about which changes matter, sitting nowhere near the rule it second-guesses. In
 * practice the one that lands is `issue_linked` — a new PR referencing the issue
 * is the world saying there is more here — or a reopen, which says it louder.
 *
 * **There is no timer arm**, and that asymmetry with `proposalHold`'s accepted
 * window is the point. An accepted act waits on the world to *reflect* something
 * already done, which is a duration. A delivered issue waits on the world to
 * *become* something else, which is an event. A verdict that expired on a clock
 * would mean "delivered for now", and re-picking work that was genuinely
 * delivered is the precise failure this exists to stop.
 *
 * The third clearer is the operator deleting the row, which is why it is not an
 * arm: `Store.clearDelivery` removes it, so "not delivered" keeps exactly one
 * representation — the same reason clearing a conclusion is a delete.
 *
 * Expiry lifts the hold; it does not retract the verdict. The row stays, so the
 * assessor's summary remains readable as the last thing said about the issue.
 */

/** What a hold is judged against: the tracker's pickup states, and the world since the verdict. */
interface DeliveryHoldContext {
  /**
   * The configured pickup states (`issuePickupStates`). Empty or absent on a
   * provider with no work-item states, which leaves the first arm unable to fire —
   * exactly the case the signal arm covers.
   */
  pickupStates?: string[];
  /**
   * World transitions covering at least {@link deliverySignalQuery}'s window.
   * Absent = nothing observed, so every verdict still stands. That is the
   * direction that holds rather than acts, which is the one to take when a caller
   * has not wired the read.
   */
  signals?: WorldEvent[];
}

/**
 * The world item a delivery verdict is about. Not exported, for
 * `proposalWorldRef`'s reason: it is used both to *match* events and to *ask* for
 * them, and those two answering differently is the bug class this repo has fixed
 * twice. A `delivered` row is only ever keyed on `issue:<n>`, so this is a
 * narrowing rather than a parse — anything else yields null and is never expired
 * by a signal it cannot be matched against.
 */
function deliveryWorldRef(originRef: string): string | null {
  return /^issue:\d+$/.test(originRef) ? originRef : null;
}

/**
 * How each author is named to the operator, in the middle of a sentence.
 *
 * One record rather than a ternary per site, and a `Record<DeliveryAuthor, …>`
 * rather than a lookup with a fallback: the two sites that say this — the hold
 * reason here and the close-out card in `src/delivery/closeOut.ts` — read the
 * same row, and a fourth author does not compile until it has been given words.
 * A fallback would have named it "the assessor" instead, which is the quiet
 * misattribution this shape exists to make impossible.
 */
export const DELIVERY_AUTHOR: Record<DeliveryAuthor, string> = {
  operator: 'you',
  assessor: 'the assessor',
  planner: 'the planner',
};

/**
 * Why this issue is held out of pickup by a standing delivery verdict, or null
 * when it is free. The string is operator-facing — it is what the cockpit chip
 * and the dispatcher's skip reason both render.
 */
export function deliveryHold(
  delivery: IssueDelivery | null,
  issue: Issue,
  ctx: DeliveryHoldContext = {},
): string | null {
  if (!delivery) return null;

  // The operator moved the ticket back into a pickup state: they want it worked,
  // and a verdict that argued with that would leave them no way to say so.
  const state = issue.workItemState;
  if (state !== undefined && (ctx.pickupStates ?? []).includes(state)) return null;

  if (expiringSignal(delivery, ctx.signals ?? [])) return null;

  return (
    `${DELIVERY_AUTHOR[delivery.by]} marked it delivered` +
    `${delivery.summary ? ` — "${delivery.summary}"` : ''} (${delivery.decidedAt})`
  );
}

/**
 * The transition that ended a verdict's standing, or null while it still stands.
 *
 * Measured against {@link verdictCast} — when the verdict *standing now* was
 * cast — never against `decided_at`, which dates the first one. A row is
 * overwritten in place, so after any re-cast the two are different instants, and
 * reading the older of them judges the live verdict against a transition that
 * happened before it existed.
 */
function expiringSignal(delivery: IssueDelivery, signals: WorldEvent[]): WorldEvent | null {
  const item = deliveryWorldRef(delivery.originRef);
  if (!item) return null;
  const cast = verdictCast(delivery);
  return signals.find((e) => e.ref === item && e.createdAt > cast) ?? null;
}

/**
 * When the verdict that is standing *now* was cast.
 *
 * `decided_at` is preserved across an overwrite so the row keeps dating the
 * moment the issue was first judged — which is what the cockpit chip and the
 * hold's own reason string quote, and is a different fact from this one.
 * `updated_at` moves with the re-cast, so it is the instant "any transition
 * after the verdict" is actually about. Falls back for a row read out of a
 * database written before the column carried one.
 */
function verdictCast(delivery: IssueDelivery): string {
  return delivery.updatedAt ?? delivery.decidedAt;
}

/**
 * Which world events {@link deliveryHold} needs to answer "has anything happened
 * since this was judged delivered", as a query — the items to look at and how far
 * back.
 *
 * Bounded by *time and item* rather than by row count, mirroring
 * `rejectionSignalQuery` and for its reason. `Store.listDeliveries` is unbounded
 * on purpose, so a count-bounded event read would reintroduce the asymmetry from
 * the other side: a verdict older than the window would be judged against events
 * it cannot see, and would hold forever. Asking for "events for these issues since
 * the oldest standing verdict" leaves that case no answer to get wrong.
 *
 * Null when nothing is standing, which is every deployment until an issue is
 * assessed: no query, no read.
 */
export function deliverySignalQuery(deliveries: IssueDelivery[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  let since: string | null = null;
  for (const d of deliveries) {
    const item = deliveryWorldRef(d.originRef);
    if (!item) continue;
    refs.add(item);
    // The same instant the predicate compares against, so the window shrinks
    // with a re-cast and the transition that expired the *previous* verdict
    // stops being fetched at all. Taken off `decided_at` instead, a stale event
    // stays inside the window for as long as the row exists — `world_events` is
    // never pruned — and no verdict on that issue could ever hold again.
    const cast = verdictCast(d);
    if (since === null || cast < since) since = cast;
  }
  return since !== null && refs.size > 0 ? { since, refs: [...refs] } : null;
}
