import type { CockpitActions } from '../cockpit/actions.js';
import type { Destination } from '../components/button.js';
import type { NeedRow } from '../view/needsYou.js';
import { panelUsage } from '../cockpit/usage.js';
import { openGoalForAsk } from './jump.js';

// → docs/spec/17-cockpit.md

/* Narrowed at the one place that needs it, so `selectPr` is never handed the
   number of an ask whose destination is not a pull request. */

export function rowDestination(row: NeedRow, dest: NeedRow['opens'], actions: CockpitActions): Destination | null {
  const ref = row.goalRef;
  const prOf = (r: NeedRow): number => r.prNumber ?? 0;
  if (dest === 'build') return { go: () => actions.openPanel('build'), usage: panelUsage('build') };
  if (dest === 'goal') {
    return ref === null ? null : { go: () => openGoalForAsk(actions, ref, row.kind), usage: { counted: 'goal.view' } };
  }
  if (dest === 'pr') {
    return row.prNumber === undefined ? null : { go: () => actions.selectPr(prOf(row)), usage: { counted: 'pr.view' } };
  }
  if (dest === 'prediction') {
    return ref === null ? null : { go: () => actions.openGoalPrediction(ref), usage: { counted: 'goal.view' } };
  }
  if (dest === 'ask') return askDestination(row, actions);
  return null;
}

function askDestination(row: NeedRow, actions: CockpitActions): Destination {
  return { go: () => actions.openPanel({ ask: row.id }), usage: { counted: 'escalation.view' } };
}

export function openRow(row: NeedRow, actions: CockpitActions): Destination {
  return rowDestination(row, row.opens, actions) ?? askDestination(row, actions);
}
