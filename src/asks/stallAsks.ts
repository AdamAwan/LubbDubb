import type { AskDraft, AskInputs } from './queue.js';

// → docs/spec/04-harness-cycle.md#when-the-fleet-stops-dispatching

const REFUSAL_CHARS = 200;

function clipped(text: string): string {
  return text.length > REFUSAL_CHARS ? `${text.slice(0, REFUSAL_CHARS - 1)}…` : text;
}

/** One row while the fleet reads as stalled; none the cycle a dispatch gets through. */
export function fleetStallRows(state: AskInputs): AskDraft[] {
  const stall = state.fleetStall;
  if (stall === null) return [];
  const n = stall.candidates.length;
  const why = stall.refusal === null ? 'no dispatch was attempted' : clipped(stall.refusal);
  return [
    {
      id: 'fleet-stall',
      kind: 'fleet_stall',
      subject: { type: 'fleet_stall' },
      group: 'blocking',
      title:
        `The fleet has started nothing for ${stall.cycles} cycles with ${n} candidate${n === 1 ? '' : 's'} ` +
        `up next and room under the cap — ${why}`,
      goalRef: null,
      originRef: stall.candidates[0] ?? null,
      opens: null,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: stall.since,
    },
  ];
}
