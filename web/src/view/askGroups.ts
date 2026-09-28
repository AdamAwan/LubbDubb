import type { AppState } from '../types.js';
import type { NeedRow } from './needsYou.js';

// → docs/spec/17-cockpit.md#the-same-ask-twice-is-one-ask

type AskItem = { kind: 'one'; row: NeedRow } | { kind: 'assign'; rows: NeedRow[] };

/**
 * Folds the assign asks that would be answered with the same buttons into one item, drawn where the
 * first of them stood. Two asks with different shortlists are two questions and stay apart.
 */
export function groupAsks(rows: readonly NeedRow[], state: AppState): AskItem[] {
  const items: AskItem[] = [];
  const groups = new Map<string, NeedRow[]>();
  for (const row of rows) {
    const key = assignKey(row, state);
    if (key === null) {
      items.push({ kind: 'one', row });
      continue;
    }
    const held = groups.get(key);
    if (held !== undefined) {
      held.push(row);
      continue;
    }
    const fresh = [row];
    groups.set(key, fresh);
    items.push({ kind: 'assign', rows: fresh });
  }
  return items.map((item) => {
    if (item.kind !== 'assign') return item;
    const [only, ...rest] = item.rows;
    return only !== undefined && rest.length === 0 ? { kind: 'one', row: only } : item;
  });
}

function assignKey(row: NeedRow, state: AppState): string | null {
  if (row.kind !== 'assign') return null;
  const pr = state.world.pullRequests.find((p) => p.number === row.prNumber);
  if (pr?.assignAsk === undefined) return null;
  return `${row.goalRef ?? ''}|${pr.assignAsk.map((p) => p.id).join(',')}`;
}
