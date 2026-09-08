import type { Escalation, Proposal, PrState } from '../types.js';

// → docs/spec/07-pull-requests.md#a-merge-ask-outlives-its-pull-request

interface SettledMergeAsk {
  prNumber: number;
  state: Exclude<PrState, 'open'>;
  verdict: string;
  proposalIds: string[];
  escalationIds: string[];
}

const MERGE_REF = /^pr:(\d+):merge$/;

function mergeAskFor(esc: Escalation): number | null {
  if (esc.type !== 'approve_change') return null;
  const { prNumber, method } = esc.context;
  if (typeof prNumber !== 'number' || typeof method !== 'string') return null;
  return prNumber;
}

function pendingMergeFor(proposal: Proposal): number | null {
  if (proposal.kind !== 'merge' || proposal.status !== 'pending') return null;
  const match = MERGE_REF.exec(proposal.ref);
  return match ? Number(match[1]) : null;
}

export function settledMergeAsks(input: {
  proposals: Proposal[];
  openEscalations: Escalation[];
  settledPrs: ReadonlyMap<number, Exclude<PrState, 'open'>>;
}): SettledMergeAsk[] {
  const asks = new Map<number, SettledMergeAsk>();
  const claim = (prNumber: number): SettledMergeAsk | null => {
    const state = input.settledPrs.get(prNumber);
    if (state === undefined) return null;
    const standing = asks.get(prNumber);
    if (standing) return standing;
    const fresh: SettledMergeAsk = {
      prNumber,
      state,
      verdict:
        state === 'merged'
          ? `PR #${prNumber} merged; there is nothing left to approve.`
          : `PR #${prNumber} was closed without merging; there is nothing left to approve.`,
      proposalIds: [],
      escalationIds: [],
    };
    asks.set(prNumber, fresh);
    return fresh;
  };

  for (const proposal of input.proposals) {
    const prNumber = pendingMergeFor(proposal);
    if (prNumber === null) continue;
    claim(prNumber)?.proposalIds.push(proposal.id);
  }
  for (const esc of input.openEscalations) {
    const prNumber = mergeAskFor(esc);
    if (prNumber === null) continue;
    claim(prNumber)?.escalationIds.push(esc.id);
  }
  return [...asks.values()].sort((a, b) => a.prNumber - b.prNumber);
}
