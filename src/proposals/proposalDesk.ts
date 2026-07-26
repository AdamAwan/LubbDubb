import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionExecutor } from '../executor/actionExecutor.js';
import type { Proposal } from '../types.js';

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
    const run = await this.executor.runAuthorized(proposal);
    return { proposal, outcome: run.ok ? 'performed' : 'failed', detail: run.detail };
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
    const detail = `Rejected by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was sent (${proposal.id}).`;
    this.store.recordDecision({
      cycleId: `human:${proposal.id}`,
      action: proposal.action,
      outcome: 'skipped',
      detail,
    });
    return { proposal, outcome: 'none', detail };
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
