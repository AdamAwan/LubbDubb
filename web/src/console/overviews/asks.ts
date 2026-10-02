import type { NeedRow } from '../../view/needsYou.js';

// → docs/spec/17-cockpit.md#one-ask-at-a-time

/** The one-at-a-time order, which the server decided and shipped as each row's `focusRank`. */
export function byFocusRank(a: NeedRow, b: NeedRow): number {
  return a.focusRank - b.focusRank;
}

/** How many parts are stalled behind the whole set, which is the banner's number. */
export function partsHeld(rows: readonly NeedRow[]): number {
  return rows.reduce((sum, row) => sum + row.holding, 0);
}
