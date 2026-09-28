import type { AppState, OpenPullRequest } from '../types.js';
import type { NeedRow } from './needsYou.js';

// → docs/spec/17-cockpit.md#the-same-ask-twice-is-one-ask

export type AssignAsk = Required<Pick<OpenPullRequest, 'number' | 'title' | 'assignAsk'>>;

type AskItem = { kind: 'one'; row: NeedRow } | { kind: 'assign'; first: NeedRow; asks: AssignAsk[] };

export function assignGroupLine(count: number): string {
  return `${count} pull requests are ready and nobody is on them`;
}

export function assignAskOf(row: NeedRow, state: AppState): AssignAsk | null {
  if (row.kind !== 'assign') return null;
  const pr = state.world.pullRequests.find((p) => p.number === row.prNumber);
  return pr?.assignAsk === undefined ? null : { number: pr.number, title: pr.title, assignAsk: pr.assignAsk };
}

/**
 * Folds the assign asks that would be answered with the same buttons into one item, drawn where the
 * first of them stood. Two asks with different shortlists are two questions and stay apart.
 */
export function groupAsks(rows: readonly NeedRow[], state: AppState): AskItem[] {
  const resolved = rows.map((row) => {
    const ask = assignAskOf(row, state);
    return { row, ask, key: ask === null ? null : `${row.goalRef ?? ''}|${ask.assignAsk.map((p) => p.id).join(',')}` };
  });
  const groups = new Map<string, AssignAsk[]>();
  for (const { ask, key } of resolved) {
    if (ask === null || key === null) continue;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [ask]);
    else group.push(ask);
  }
  const drawn = new Set<string>();
  const items: AskItem[] = [];
  for (const { row, key } of resolved) {
    const group = key === null ? undefined : groups.get(key);
    if (key === null || group === undefined || group.length === 1) items.push({ kind: 'one', row });
    else if (!drawn.has(key)) {
      drawn.add(key);
      items.push({ kind: 'assign', first: row, asks: group });
    }
  }
  return items;
}
