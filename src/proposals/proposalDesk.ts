import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionExecutor } from '../executor/actionExecutor.js';
import type { Proposal } from '../types.js';
import { refusePlan } from '../plans/planApproval.js';
import { declinePlanAmendment } from '../plans/planAmendment.js';
import { backOutOfPlan, type BackOutContext, type BackOutVerdict } from '../plans/planBackOut.js';
import { readProposedAct } from './proposals.js';

interface DecideResult {
  proposal: Proposal;
  /** What the verdict caused: the act ran, the act failed, or nothing (a rejection). */
  outcome: 'performed' | 'failed' | 'none';
  /** The audit line, so the operator sees what their click did without opening the log. */
  detail: string;
}

/**
 * Where a human's verdict is applied (issue #109). Small on purpose — the three
 * things it does are the three the issue says have to hold:
 *
 * It is deliberately only the *human* desk. Auto-send settles its own proposals
 * in the executor, on the pulse (issue #109 phase 2), because there is no inbox
 * item to close and no route to answer — but it settles them with the same
 * one-way transition and runs them through the same
 * {@link ActionExecutor.runAuthorized}, so "who authorized this" has one answer
 * shape whichever decider gave it.
 *
 * 1. **One-way transition.** The `pending → accepted | rejected` move is a
 *    compare-and-set in the store, so accepting twice performs the act once. The
 *    second call finds nothing pending and gets `null`, exactly as a second
 *    sentinel report is a no-op.
 * 2. **Accept does the thing.** The act runs *inline*, through
 *    {@link ActionExecutor.runAuthorized} and so through the one `ActionSink`.
 *    The alternative — parking the accepted proposal for the next pulse to
 *    execute — buys nothing: the action is already formed and validated, so the
 *    dispatcher would only re-emit what the row already holds, and it costs a
 *    pulse of latency plus an "accepted but not yet run" state that needs its own
 *    one-way transition to stay idempotent. One transition is the whole point.
 * 3. **The escalation stays the inbox.** The item it hangs off is answered with
 *    the verdict, so "what is waiting on me" empties on the click rather than
 *    keeping a question whose answer already exists.
 */
export class ProposalDesk {
  constructor(
    private readonly store: Store,
    private readonly escalations: EscalationInbox,
    private readonly executor: ActionExecutor,
    /**
     * What backing out of a plan needs beyond the store — the outbound seam and
     * the error log. Carried rather than reached for, because the two back-out
     * verdicts write to somebody else's tracker and the desk is where a verdict's
     * effect belongs (see {@link ProposalDesk.backOut}).
     */
    private readonly backOutCtx: Omit<BackOutContext, 'store'>,
  ) {}

  /** Authorize the act. Returns null if it was already decided (or never existed). */
  async accept(id: string, note?: string): Promise<DecideResult | null> {
    const proposal = this.store.decideProposal(id, 'accepted', note?.trim() || null, 'human');
    if (!proposal) return null;
    this.closeEscalation(proposal, `Accepted${proposal.note ? `: ${proposal.note}` : '.'}`);
    // No cycle id: a human decides outside the pulse, and `runAuthorized` records
    // it as such. Auto-send is the caller that passes one (see `ActionExecutor`).
    const run = await this.executor.runAuthorized(proposal);
    return { proposal, outcome: run.outcome === 'executed' ? 'performed' : 'failed', detail: run.detail };
  }

  /**
   * Refuse the act. Nothing goes out, and the reason is recorded — both on the
   * proposal (where the gate reads it, so the harness does not ask again) and in
   * the decision log (where every other outcome is explained).
   */
  reject(id: string, note?: string): DecideResult | null {
    const proposal = this.store.decideProposal(id, 'rejected', note?.trim() || null, 'human');
    if (!proposal) return null;
    this.closeEscalation(proposal, `Rejected${proposal.note ? `: ${proposal.note}` : '.'}`);
    // Refusing an outbound act is entirely a matter of *not* doing something. A
    // plan is the one kind where "no" needs an effect of its own: a plan is the
    // only thing that schedules anything for a decomposed issue, so a refusal
    // that merely stopped the parts would park the issue for good. `refusePlan`
    // is what leaves it a route — see there for which one and why.
    const consequence = this.settlePlan(proposal);
    const detail = `Rejected by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was sent${consequence} (${proposal.id}).`;
    this.store.recordDecision({
      cycleId: `human:${proposal.id}`,
      action: proposal.action,
      outcome: 'skipped',
      detail,
    });
    return { proposal, outcome: 'none', detail };
  }

  /**
   * Back out of a plan without answering the question it asked — the two verdicts
   * that are about the **ticket** rather than about the plan (see
   * `src/plans/planBackOut.ts`).
   *
   * It settles the proposal exactly as {@link reject} does, and for the same
   * reason: the act was not authorized, so the row must leave `pending` in the one
   * direction that says so, the inbox item must be answered with it, and the
   * decision log must carry what the click did. What differs is entirely the
   * effect. A close ends the plan outright (`declinePlan`) and concludes the goal;
   * a hold reaches `refusePlan` after all, but with the watch tag off — so the
   * replan it sets up costs nothing until somebody asks for the goal again, and
   * what comes back then is a new plan rather than this one re-proposed.
   *
   * Refused for anything but a `plan` proposal: a merge or a reply draft has no
   * ticket behind it to close or hold, and a shortfall's ticket is one the harness
   * has already delivered against. Null when it was already decided, exactly as
   * accepting and rejecting are.
   */
  async backOut(id: string, verdict: BackOutVerdict, note?: string): Promise<DecideResult | null> {
    // Read before the transition, so a proposal of the wrong kind is refused rather
    // than settled into a verdict whose effect cannot run.
    const standing = this.store.getProposal(id);
    if (!standing || standing.status !== 'pending') return null;
    if (standing.kind !== 'plan') return null;

    const proposal = this.store.decideProposal(id, 'rejected', note?.trim() || null, 'human');
    if (!proposal) return null;
    const what = verdict === 'close' ? 'Closed the ticket' : 'Put the ticket on hold';
    this.closeEscalation(proposal, `${what}${proposal.note ? `: ${proposal.note}` : '.'}`);

    const read = readProposedAct(proposal);
    const consequence =
      read.ok && read.act.kind === 'plan'
        ? (await backOutOfPlan({ ...this.backOutCtx, store: this.store }, read.act, verdict, proposal.note)).detail
        : `the plan could not be settled (${read.ok ? 'the row names no plan' : read.error})`;
    const detail = `${what} by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was scheduled; ${consequence} (${proposal.id}).`;
    this.store.recordDecision({
      cycleId: `human:${proposal.id}`,
      action: proposal.action,
      outcome: 'skipped',
      detail,
    });
    return { proposal, outcome: 'none', detail };
  }

  /**
   * The plan half of a rejection, as a clause for the audit line — empty for the
   * two kinds where refusing really is just not acting. Read through the same
   * `readProposedAct` an accept uses, so a malformed row is reported rather than
   * silently skipping the transition that leaves the issue a route.
   */
  private settlePlan(proposal: Proposal): string {
    // A refused *amendment* is the one settlement in the funnel with no effect on
    // the goal, and it still needs a write: the row it leaves pending would be
    // re-proposed on the next pulse, so the refusal has to reach
    // `plan_amendments` even though it reaches nothing else. The plan is untouched
    // on purpose — carrying on as planned is what "no" means here.
    if (proposal.kind === 'plan_amendment') {
      const readAmendment = readProposedAct(proposal);
      if (!readAmendment.ok || readAmendment.act.kind !== 'plan_amendment')
        return `; the amendment could not be settled (${readAmendment.ok ? 'the row names no amendment' : readAmendment.error})`;
      return `; ${declinePlanAmendment(this.store, readAmendment.act.amendmentId, proposal.note).detail}`;
    }
    if (proposal.kind !== 'plan') return '';
    const read = readProposedAct(proposal);
    if (!read.ok || read.act.kind !== 'plan') return `; the plan could not be settled (${read.ok ? '' : read.error})`;
    // The operator's own words ride along: a refused *single* verdict goes back to
    // a planner, and a planner shown only "declined" has no reason to decide
    // differently to the way it just decided.
    return `; ${refusePlan(this.store, read.act.planId, read.act.originRef, proposal.note).detail}`;
  }

  /**
   * Answer the proposal's inbox item with the verdict, if it is still open. Best
   * effort by design: a proposal whose escalation was dismissed (its agent died,
   * say) is still perfectly decidable — the act is the harness's, not the agent's.
   */
  private closeEscalation(proposal: Proposal, verdict: string): void {
    if (!proposal.escalationId) return;
    const esc = this.store.getEscalation(proposal.escalationId);
    if (esc?.status === 'open') this.escalations.answer(esc.id, verdict);
  }
}
