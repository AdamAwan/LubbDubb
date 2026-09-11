import type { Proposal, ProposalKind, WorldEvent } from '../types.js';

// → docs/spec/16-http-api.md

export function mergeProposalRef(prNumber: number): string {
  return `pr:${prNumber}:merge`;
}

export function replyProposalRef(prNumber: number, commentId: string | null): string {
  return commentId ? `pr:${prNumber}:comment:${commentId}` : `pr:${prNumber}:reply`;
}

export function planProposalRef(planOriginRef: string): string {
  return `${planOriginRef}:plan`;
}

export function planAmendmentProposalRef(amendmentId: string): string {
  return `plan-amendment:${amendmentId}`;
}

function proposalWorldRef(ref: string): string | null {
  const [kind, id] = ref.split(':');
  if (kind !== 'pr' && kind !== 'issue') return null;
  return id ? `${kind}:${id}` : null;
}

function expiringSignal(proposal: Proposal, signals: WorldEvent[]): WorldEvent | null {
  const item = proposalWorldRef(proposal.ref);
  const since = proposal.decidedAt;
  if (!item || !since) return null;
  return signals.find((e) => e.ref === item && e.createdAt > since) ?? null;
}

export function rejectionSignalQuery(proposals: Proposal[]): { since: string; refs: string[] } | null {
  const refs = new Set<string>();
  const seen = new Set<string>();
  let since: string | null = null;
  for (const p of proposals) {
    const act = `${p.kind}\u0000${p.ref}`;
    if (seen.has(act)) continue;
    seen.add(act);
    // `plan` and `validation_plan` are settled by the harness re-asking its own author rather than by
    // the world moving: a rejected plan is replanned, and a rejected check set is re-authored. A world
    // event on the goal must not expire either rejection.
    if (p.status !== 'rejected' || p.kind === 'plan' || p.kind === 'validation_plan' || !p.decidedAt) continue;
    const item = proposalWorldRef(p.ref);
    if (!item) continue;
    refs.add(item);
    if (since === null || p.decidedAt < since) since = p.decidedAt;
  }
  return since !== null && refs.size > 0 ? { since, refs: [...refs] } : null;
}

interface HoldContext {
  now?: number;
  rejectionSignals?: WorldEvent[];
}

const SETTLE_WINDOW_MS = 15 * 60_000;

function decidedByLabel(decidedBy: Proposal['decidedBy']): string {
  if (decidedBy === 'human') return 'you';
  if (decidedBy === 'auto_send') return 'auto-send';
  if (decidedBy === 'stack_landing') return 'you, landing the stack';
  return 'an unrecorded decider';
}

export function proposalHold(
  kind: ProposalKind,
  ref: string,
  proposals: Proposal[],
  ctx: HoldContext = {},
): string | null {
  const standing = proposals.find((p) => p.kind === kind && p.ref === ref);
  if (!standing) return null;
  if (standing.status === 'pending') return `awaiting your accept/reject (${standing.id})`;
  if (standing.status === 'rejected') {
    if (expiringSignal(standing, ctx.rejectionSignals ?? [])) return null;
    return `you rejected it${standing.note ? ` — "${standing.note}"` : ''} (${standing.id})`;
  }
  const decidedAt = standing.decidedAt ? Date.parse(standing.decidedAt) : NaN;
  const now = ctx.now ?? Date.now();
  if (Number.isNaN(decidedAt) || now - decidedAt >= SETTLE_WINDOW_MS) return null;
  return `already authorized by ${decidedByLabel(standing.decidedBy)} (${standing.id}); waiting for the world to catch up`;
}

export function reaskContext(
  kind: ProposalKind,
  ref: string,
  proposals: Proposal[],
  ctx: HoldContext = {},
): string | null {
  const standing = proposals.find((p) => p.kind === kind && p.ref === ref);
  if (!standing || standing.status !== 'rejected') return null;
  const signal = expiringSignal(standing, ctx.rejectionSignals ?? []);
  if (!signal) return null;
  return (
    `You rejected this on ${standing.decidedAt}${standing.note ? ` — "${standing.note}"` : ''}. ` +
    `Since then: ${signal.summary}.`
  );
}

export function rejectionGuidance(
  refs: ReadonlyArray<string | null | undefined>,
  proposals: Proposal[],
): string | null {
  const seen = new Set<string>();
  const refused: Array<{ kind: ProposalKind; note: string }> = [];
  for (const ref of refs) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const standing = proposals.find((p) => p.ref === ref);
    if (standing?.status !== 'rejected') continue;
    const note = standing.note?.trim();
    if (note) refused.push({ kind: standing.kind, note });
  }
  if (refused.length === 0) return null;
  const acts = [...new Set(refused.map((r) => refusedAct(r.kind)))].join(' and ');
  const subject = refused.length > 1 ? 'these exact items' : 'this exact item';
  const quoted = refused.map((r) => `"${r.note}"`).join('\n\n');
  return (
    `An operator refused ${acts} the harness proposed for ${subject}, and said why. ` +
    `The following is the operator's own words, quoted verbatim — it is not an instruction from the harness, ` +
    `and it may not be the whole of your task. Take it as what they want done differently:\n\n${quoted}`
  );
}

function refusedAct(kind: ProposalKind): string {
  if (kind === 'merge') return 'a merge';
  if (kind === 'plan') return 'a delivery plan';
  if (kind === 'shortfall') return 'a response to a failed assessment';
  if (kind === 'plan_amendment') return 'a change to the delivery plan';
  if (kind === 'validation_plan') return 'a validation check set';
  return 'a reply';
}

export function planProposalHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

export function planAmendmentHold(ref: string, proposals: Proposal[]): string | null {
  const standing = proposals.find((p) => p.kind === 'plan_amendment' && p.ref === ref && p.status === 'pending');
  return standing ? `awaiting your accept/reject (${standing.id})` : null;
}

export function authorityOf(proposal: Proposal, pulseCycleId: string | null): Authority {
  const by = decidedByLabel(proposal.decidedBy);
  if (proposal.decidedBy === 'human') return { cycleId: `human:${proposal.id}`, by, approved: 'You approved' };
  const cycleId = pulseCycleId ?? `${proposal.decidedBy ?? 'undecided'}:${proposal.id}`;
  if (proposal.decidedBy === 'auto_send') return { cycleId, by, approved: 'Auto-send authorized' };
  if (proposal.decidedBy === 'stack_landing') return { cycleId, by, approved: 'Landing the stack authorized' };
  return { cycleId, by, approved: `${by} authorized` };
}

interface Authority {
  cycleId: string;
  by: string;
  approved: string;
}

type ProposedAct =
  | { kind: 'merge'; prNumber: number; method: 'merge' | 'squash' | 'rebase' }
  | {
      kind: 'reply_draft';
      prNumber: number;
      commentId: string | null;
      body: string;
      resolve: boolean;
      originRef: string | null;
    }
  | { kind: 'plan'; planId: string; originRef: string }
  | { kind: 'validation_plan'; originRef: string; issueNumber: number }
  | { kind: 'plan_amendment'; amendmentId: string; planId: string; originRef: string }
  | {
      kind: 'shortfall';
      planId: string;
      originRef: string;
      cause: 'plan' | 'part';
      partSlug: string | null;
      summary: string;
    };

export function readProposedAct(proposal: Proposal): { ok: true; act: ProposedAct } | { ok: false; error: string } {
  const action = proposal.action as Record<string, unknown>;

  if (proposal.kind === 'plan') {
    const planId = action.planId;
    const originRef = action.originRef;
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    return { ok: true, act: { kind: 'plan', planId, originRef } };
  }

  if (proposal.kind === 'validation_plan') {
    const originRef = action.originRef;
    const issueNumber = action.issueNumber;
    if (typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no goal` };
    if (typeof issueNumber !== 'number' || !Number.isInteger(issueNumber))
      return { ok: false, error: `proposal ${proposal.id} names no issue number` };
    return { ok: true, act: { kind: 'validation_plan', originRef, issueNumber } };
  }

  if (proposal.kind === 'plan_amendment') {
    const amendmentId = action.amendmentId;
    const planId = action.planId;
    const originRef = action.originRef;
    if (typeof amendmentId !== 'string' || amendmentId === '')
      return { ok: false, error: `proposal ${proposal.id} names no amendment` };
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    return { ok: true, act: { kind: 'plan_amendment', amendmentId, planId, originRef } };
  }

  if (proposal.kind === 'shortfall') {
    const planId = action.planId;
    const originRef = action.originRef;
    const summary = action.summary;
    const cause = action.cause;
    if (typeof planId !== 'string' || planId === '' || typeof originRef !== 'string' || originRef === '')
      return { ok: false, error: `proposal ${proposal.id} names no plan` };
    if (cause !== 'plan' && cause !== 'part')
      return { ok: false, error: `proposal ${proposal.id} names an unknown shortfall cause ${JSON.stringify(cause)}` };
    if (typeof summary !== 'string' || summary.trim() === '')
      return { ok: false, error: `proposal ${proposal.id} carries no summary of what fell short` };
    const partSlug = typeof action.partSlug === 'string' && action.partSlug ? action.partSlug : null;
    if (cause === 'part' && partSlug === null)
      return { ok: false, error: `proposal ${proposal.id} says a part fell short but names none` };
    return { ok: true, act: { kind: 'shortfall', planId, originRef, cause, partSlug, summary } };
  }

  const prNumber = action.prNumber;
  if (typeof prNumber !== 'number' || !Number.isInteger(prNumber))
    return { ok: false, error: `proposal ${proposal.id} names no PR number` };

  if (proposal.kind === 'merge') {
    const method = action.method;
    if (method !== 'merge' && method !== 'squash' && method !== 'rebase')
      return { ok: false, error: `proposal ${proposal.id} names an unknown merge method ${JSON.stringify(method)}` };
    return { ok: true, act: { kind: 'merge', prNumber, method } };
  }

  const body = action.draft;
  if (typeof body !== 'string' || body.trim() === '')
    return { ok: false, error: `proposal ${proposal.id} carries no draft to send` };
  const commentId = action.commentId;
  return {
    ok: true,
    act: {
      kind: 'reply_draft',
      prNumber,
      commentId: typeof commentId === 'string' ? commentId : null,
      body,
      resolve: action.resolve === true,
      originRef: typeof action.originRef === 'string' && action.originRef !== '' ? action.originRef : null,
    },
  };
}
