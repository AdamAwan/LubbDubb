import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionExecutor } from '../executor/actionExecutor.js';
import type { CheckDecline, PlanCaveat, Proposal } from '../types.js';
import { refusePlan } from '../plans/planApproval.js';
import { declinePlanAmendment } from '../plans/planAmendment.js';
import {
  answeredCaveats,
  proposedCaveats,
  unacknowledgedCaveats,
  type CaveatAnswerInput,
} from '../plans/planCaveats.js';
import { backOutOfPlan, type BackOutContext, type BackOutVerdict } from '../plans/planBackOut.js';
import { resolveDeclines, wholeSetNote } from '../validation/planDecline.js';
import { readProposedAct } from './proposals.js';

// → docs/spec/16-http-api.md

interface UnacknowledgedCaveats {
  unacknowledged: PlanCaveat[];
}

interface DecideResult {
  proposal: Proposal;
  outcome: 'performed' | 'failed' | 'none';
  detail: string;
}

export class ProposalDesk {
  constructor(
    private readonly store: Store,
    private readonly escalations: EscalationInbox,
    private readonly executor: ActionExecutor,
    private readonly backOutCtx: Omit<BackOutContext, 'store'>,
  ) {}

  async accept(
    id: string,
    note?: string,
    acknowledged: readonly string[] = [],
    answers: readonly CaveatAnswerInput[] = [],
    declined: readonly CheckDecline[] = [],
  ): Promise<DecideResult | UnacknowledgedCaveats | null> {
    const standing = this.store.escalations.getProposal(id);
    const raised = standing ? proposedCaveats(standing) : [];
    if (standing && standing.status === 'pending') {
      const unacknowledged = unacknowledgedCaveats(raised, acknowledged);
      if (unacknowledged.length > 0) return { unacknowledged };
    }
    const wholeSet = this.declinedWholeSet(standing, declined, note);
    // Declining every row is not an accept of nothing. A released set of no rows reads exactly like
    // a planner that legitimately declared none with an `emptyReason`, and the two must stay
    // distinguishable — so the press lands on the machinery that already exists for *send it back*,
    // carrying the operator's row-by-row words to the next planner.
    // → docs/spec/20-validation.md#declining-a-single-row
    if (wholeSet !== null) return this.reject(id, wholeSet);
    const proposal = this.store.escalations.decideProposal(id, 'accepted', note?.trim() || null, 'human');
    if (!proposal) return null;
    this.recordAnswers(proposal, raised, answers);
    this.closeEscalation(proposal, `Accepted${proposal.note ? `: ${proposal.note}` : '.'}`);
    const run = await this.executor.runAuthorized(proposal, undefined, declined);
    return { proposal, outcome: run.outcome === 'executed' ? 'performed' : 'failed', detail: run.detail };
  }

  reject(id: string, note?: string): DecideResult | null {
    const proposal = this.store.escalations.decideProposal(id, 'rejected', note?.trim() || null, 'human');
    if (!proposal) return null;
    this.closeEscalation(proposal, `Rejected${proposal.note ? `: ${proposal.note}` : '.'}`);
    const consequence = this.settlePlan(proposal);
    const detail = `Rejected by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was sent${consequence} (${proposal.id}).`;
    this.store.decisions.recordDecision({
      cycleId: `human:${proposal.id}`,
      action: proposal.action,
      outcome: 'skipped',
      detail,
    });
    return { proposal, outcome: 'none', detail };
  }

  async backOut(id: string, verdict: BackOutVerdict, note?: string): Promise<DecideResult | null> {
    const standing = this.store.escalations.getProposal(id);
    if (!standing || standing.status !== 'pending') return null;
    if (standing.kind !== 'plan') return null;

    const proposal = this.store.escalations.decideProposal(id, 'rejected', note?.trim() || null, 'human');
    if (!proposal) return null;
    const what = verdict === 'close' ? 'Closed the ticket' : 'Put the ticket on hold';
    this.closeEscalation(proposal, `${what}${proposal.note ? `: ${proposal.note}` : '.'}`);

    const read = readProposedAct(proposal);
    const consequence =
      read.ok && read.act.kind === 'plan'
        ? (await backOutOfPlan({ ...this.backOutCtx, store: this.store }, read.act, verdict, proposal.note)).detail
        : `the plan could not be settled (${read.ok ? 'the row names no plan' : read.error})`;
    const detail = `${what} by you${proposal.note ? `: ${proposal.note}` : ''} — nothing was scheduled; ${consequence} (${proposal.id}).`;
    this.store.decisions.recordDecision({
      cycleId: `human:${proposal.id}`,
      action: proposal.action,
      outcome: 'skipped',
      detail,
    });
    return { proposal, outcome: 'none', detail };
  }

  /**
   * The note a whole-set decline is rejected with, or null where this press is not one. Read off the
   * goal's own live rows rather than the ask, because the ask is what was proposed and the rows are
   * what would be released — a row superseded since must not make four declines look like five.
   */
  private declinedWholeSet(
    standing: Proposal | null,
    declined: readonly CheckDecline[],
    note: string | undefined,
  ): string | null {
    if (declined.length === 0) return null;
    if (!standing || standing.status !== 'pending' || standing.kind !== 'validation_plan') return null;
    const read = readProposedAct(standing);
    if (!read.ok || read.act.kind !== 'validation_plan') return null;
    const resolution = resolveDeclines(this.store.validation.listValidationChecks(read.act.originRef), declined);
    return resolution.whole ? wholeSetNote(resolution.resolved, note) : null;
  }

  private recordAnswers(proposal: Proposal, raised: PlanCaveat[], answers: readonly CaveatAnswerInput[]): void {
    const kept = answeredCaveats(raised, answers);
    if (kept.length === 0) return;
    const read = readProposedAct(proposal);
    if (!read.ok || read.act.kind !== 'plan') return;
    this.store.plans.recordPlanCaveatAnswers(read.act.planId, kept);
  }

  private settlePlan(proposal: Proposal): string {
    if (proposal.kind === 'validation_plan') {
      const read = readProposedAct(proposal);
      if (!read.ok || read.act.kind !== 'validation_plan')
        return `; the check set could not be settled (${read.ok ? 'the row names no goal' : read.error})`;
      const withdrawn = this.store.validation.withdrawValidationAuthoring(read.act.originRef);
      return withdrawn === null
        ? `; there was no authored check set left to send back`
        : `; the check set was sent back to be written again, and the rows it wrote are still there to amend`;
    }
    if (proposal.kind === 'plan_amendment') {
      const readAmendment = readProposedAct(proposal);
      if (!readAmendment.ok || readAmendment.act.kind !== 'plan_amendment')
        return `; the amendment could not be settled (${readAmendment.ok ? 'the row names no amendment' : readAmendment.error})`;
      return `; ${declinePlanAmendment(this.store, readAmendment.act.amendmentId, proposal.note).detail}`;
    }
    if (proposal.kind !== 'plan') return '';
    const read = readProposedAct(proposal);
    if (!read.ok || read.act.kind !== 'plan') return `; the plan could not be settled (${read.ok ? '' : read.error})`;
    return `; ${refusePlan(this.store, read.act.planId, read.act.originRef, proposal.note).detail}`;
  }

  private closeEscalation(proposal: Proposal, verdict: string): void {
    if (!proposal.escalationId) return;
    const esc = this.store.escalations.getEscalation(proposal.escalationId);
    if (esc?.status === 'open') this.escalations.answer(esc.id, verdict);
  }
}
