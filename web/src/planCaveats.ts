import type { PlanCaveat, Proposal } from './types.js';

/**
 * What a pending plan proposal says has to be **read** before it may be approved.
 *
 * The list is written by the harness (`src/plans/planCaveats.ts`) onto the action
 * the proposal carries, and the accept route refuses while any of it is unticked.
 * The cockpit reads it from the same place the gate does rather than re-deriving
 * anything from the plan row: the operator ticks ids, and a box drawn from one
 * list against a gate reading another either wedges the approval or waves it
 * through.
 *
 * `Action` is the harness's open payload shape, so the read is defensive — the same
 * narrowing the server does on the way back out of SQLite, and for the same reason.
 * A proposal from before the field existed carries none, which draws no boxes and
 * gates nothing.
 */
export function planCaveatsOf(proposal: Proposal | undefined): PlanCaveat[] {
  if (!proposal || proposal.kind !== 'plan') return [];
  const raw = (proposal.action as Record<string, unknown>).caveats;
  if (!Array.isArray(raw)) return [];
  const caveats: PlanCaveat[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, label, detail } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof label !== 'string' || label === '') continue;
    caveats.push({ id, label, detail: typeof detail === 'string' && detail ? detail : null });
  }
  return caveats;
}
