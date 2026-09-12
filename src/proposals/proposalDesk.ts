import type { Store } from '../store/store.js';
import type { EscalationInbox } from '../escalation/escalationInbox.js';
import type { ActionExecutor } from '../executor/actionExecutor.js';
import type { PlanCaveat, Proposal } from '../types.js';
import { refusePlan } from '../plans/planApproval.js';
import { declinePlanAmendment } from '../plans/planAmendment.js';
import {
  answeredCaveats,
  proposedCaveats,
  unacknowledgedCaveats,
  type CaveatAnswerInput,
} from '../plans/planCaveats.js';
import { backOutOfPlan, type BackOutContext, type BackOutVerdict } from '../plans/planBackOut.js';
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
  ): Promise<DecideResult | UnacknowledgedCaveats | null> {
    const standing = this.store.escalations.getProposal(id);
    const raised = standing ? proposedCaveats(standing) : [];
    if (standing && standing.status === 'pending') {
      const unacknowledged = unacknowledgedCaveats(raised, acknowledged);
      if (unacknowledged.length > 0) return { unacknowledged };
    }
    const proposal = this.store.escalations.decideProposal(id, 'accepted', note?.trim() || null, 'human');
    if (!proposal) return null;
    this.recordAnswers(proposal, raised, answers);
    this.closeEscalation(proposal, `Accepted${proposal.note ? `: ${proposal.note}` : '.'}`);
    const run = await this.executor.runAuthorized(proposal);
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

  private recordAnswers(proposal: Proposal, raised: PlanCaveat[], answers: readonly CaveatAnswerInput[]): void {
    const kept = answeredCaveats(raised, answers);
    if (kept.length === 0) return;
    const read = readProposedAct(proposal);
    if (!read.ok || read.act.kind !== 'plan') return;
    this.store.plans.recordPlanCaveatAnswers(read.act.planId, kept);
  }

  private settlePlan(proposal: Proposal): string {
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
