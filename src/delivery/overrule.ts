import type { Store } from '../store/store.js';
import type { IssueDelivery, IssueInstruction } from '../types.js';

/**
 * Overruling a standing shortfall: the assessment is wrong, and here is the
 * correction in the operator's own words.
 *
 * ## The gap this closes
 *
 * The shortfall card offers accept and reject, and neither says this. Accepting
 * spends an agent on a follow-up part for work that is already done; rejecting
 * means "do not act on it", which deliberately leaves the verdict standing — so
 * rule `issue-assess` dispatches again, the fresh assessor reads the same
 * repository, and records the same shortfall.
 *
 * ## Why it writes two rows
 *
 * The **delivery** is the verdict: it clears the shortfall through the exclusion
 * matrix rather than by a hand-rolled `DELETE`, parks the assessor that would
 * otherwise re-derive it, and releases the three things gated on `deliveryParked`
 * — `issue-retro`, `validate-check` and the close-out obligation.
 *
 * The **instruction** is what gets the correction into the record. The harness
 * never edits the ticket itself — only an agent can tell "this changes the goal"
 * from "this is a note about how to do the work" — so the instruction block is the
 * one mechanism there is. On a delivered goal it lands in front of the
 * retrospective agent, which is dispatched by the delivery this same call writes.
 *
 * One text, in both: the operator's words are the summary of *why* it is delivered
 * and the correction to be written down, and quoting them twice from one field is
 * what keeps the two from drifting.
 *
 * The **proposal is not settled here.** Rejecting it is the cockpit's existing call
 * and the honest verb for "no follow-up part"; folding it in would give this a
 * second opinion about a settlement `/api/proposals/:id/reject` already owns.
 *
 * Shared by the cockpit's route and the desktop channel's `goal_gate` for
 * `src/issueWatch.ts`'s reason: two rows written together are a rule, and a second
 * copy of that rule is free to write one of them.
 * → `docs/spec/11-mcp-tools.md#the-escape-hatches-a-gate-has-to-have`
 */
type OverruleOutcome =
  | { ok: true; delivery: IssueDelivery; instruction: IssueInstruction }
  | { ok: false; error: string };

export function overruleShortfall(store: OverruleStore, originRef: string, text: string): OverruleOutcome {
  // Refused rather than degraded into a plain "mark it delivered": this says one
  // specific thing — *that* verdict is wrong — and with nothing standing there is
  // no verdict to be wrong. An operator who means the plain thing has the
  // delivery for it.
  if (!store.getShortfall(originRef)) return { ok: false, error: 'no standing shortfall to overrule' };
  const delivery = store.recordDelivery({ originRef, summary: text, by: 'operator' });
  const instruction = store.addIssueInstruction({ originRef, text });
  return { ok: true, delivery, instruction };
}

/** What the overrule touches, and nothing else. */
type OverruleStore = Pick<Store, 'getShortfall' | 'recordDelivery' | 'addIssueInstruction'>;
