import type { PlanCaveat, Proposal } from './types.js';

// → docs/spec/08-planning.md

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
