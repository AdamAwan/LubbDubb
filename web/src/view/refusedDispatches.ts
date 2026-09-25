import type { AppState, CockpitDecision } from '../types.js';
import { askLine, goalOf, opensAt } from './needLines.js';
import type { NeedDraft } from './needsYou.js';

// → docs/spec/17-cockpit.md

const REFUSAL_PULSES = 3;

/**
 * A dispatch the executor has refused on every recent pulse, and what the last refusal said.
 *
 * @public read back by the needs band, which draws the refusal in full under the row
 */
export interface RefusedDispatch {
  key: string;
  originRef: string | null;
  branch: string | null;
  pulses: number;
  detail: string;
  rule: string | null;
  since: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function refusedDispatches(state: AppState): RefusedDispatch[] {
  const runs = new Map<string, CockpitDecision[]>();
  const settled = new Set<string>();
  for (const d of state.decisions ?? []) {
    if (d.action.type !== 'dispatch_code_agent' && d.action.type !== 'dispatch_desk_agent') continue;
    const key = d.subjectRef ?? str(d.action.branch);
    if (key === null || settled.has(key)) continue;
    if (d.outcome !== 'rejected') {
      settled.add(key);
      continue;
    }
    const run = runs.get(key);
    if (run) run.push(d);
    else runs.set(key, [d]);
  }
  const out: RefusedDispatch[] = [];
  for (const [key, run] of runs) {
    const pulses = new Set(run.map((d) => d.cycleId)).size;
    if (pulses < REFUSAL_PULSES) continue;
    const newest = run[0];
    const oldest = run[run.length - 1];
    if (!newest || !oldest) continue;
    out.push({
      key,
      originRef: newest.subjectRef,
      branch: str(newest.action.branch),
      pulses,
      detail: newest.detail,
      rule: newest.rule,
      since: oldest.createdAt,
    });
  }
  return out;
}

/**
 * One refused run by its row id, through the same derivation the rail's row came from.
 *
 * @public the needs band resolves the row it was handed back to its refusal
 */
export function refusedDispatchFor(state: AppState, id: string): RefusedDispatch | null {
  return refusedDispatches(state).find((r) => `dispatch:${r.key}` === id) ?? null;
}

function refusalLine(detail: string): string {
  const stop = detail.indexOf('. ');
  if (stop > 0 && stop < 200) return detail.slice(0, stop + 1);
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

export function refusedDispatchRows(state: AppState): NeedDraft[] {
  return refusedDispatches(state).map((r) => {
    const goalRef = goalOf(r.originRef, state);
    return {
      id: `dispatch:${r.key}`,
      kind: 'dispatch' as const,
      group: 'yours' as const,
      title: askLine(`Refused on ${r.pulses} pulses running — ${refusalLine(r.detail)}`, goalRef, state),
      goalRef,
      originRef: r.originRef ?? r.branch,
      opens: opensAt(goalRef, state),
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: r.since,
    };
  });
}
