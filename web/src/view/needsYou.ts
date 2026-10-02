import type { AskGroup, AskKind, AskRow, AskUrgency } from '../types.js';

// → docs/spec/17-cockpit.md#one-list-for-the-cockpit-and-for-claude-code

export type NeedKind = AskKind;
export type NeedGroup = AskGroup;
export type NeedUrgency = AskUrgency;

export interface AppliedFix {
  checkId: string;
  summary: string;
  file: string;
}

export interface NeedRow extends AskRow {
  applied?: AppliedFix;
}

/**
 * The server's queue as this browser draws it: its order, untouched, with the setup checks this
 * browser just fixed kept in their place to show their undo. A filter, never a sort.
 */
export function needsYouOf(asks: readonly AskRow[], applied: readonly AppliedFix[] = []): NeedRow[] {
  const rows: NeedRow[] = [];
  for (const row of asks) {
    const { subject } = row;
    const fix = subject.type === 'setup_check' ? applied.find((entry) => entry.checkId === subject.checkId) : undefined;
    if (!row.standing && fix === undefined) continue;
    rows.push(fix === undefined ? row : { ...row, applied: fix });
  }
  return rows;
}
