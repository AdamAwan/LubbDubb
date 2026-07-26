import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionExecutor } from '../executor/actionExecutor.js';
import type { Proposal } from '../types.js';
import { refusePlan } from '../plans/planApproval.js';
import { readProposedAct } from './proposals.js';

export interface DecideResult {
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
   * The plan half of a rejection, as a clause for the audit line — empty for the
   * two kinds where refusing really is just not acting. Read through the same
   * `readProposedAct` an accept uses, so a malformed row is reported rather than
   * silently skipping the transition that leaves the issue a route.
   */
  private settlePlan(proposal: Proposal): string {
    if (proposal.kind !== 'plan') return '';
    const read = readProposedAct(proposal);
    if (!read.ok || read.act.kind !== 'plan') return `; the plan could not be settled (${read.ok ? '' : read.error})`;
    return `; ${refusePlan(this.store, read.act.planId, read.act.originRef).detail}`;
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
