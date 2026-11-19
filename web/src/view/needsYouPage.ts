import type { CockpitView } from './viewModel.js';

export { prOnYouReasons, sameItem } from '../../../src/wire.js';

// → docs/spec/44-needs-you.md#where-it-sits

/** The Needs you page is the surface in front: its tab, with no goal or pull request opened over it. */
export function needsYouInFront(view: Pick<CockpitView, 'tab' | 'selectedGoal' | 'selectedPr'>): boolean {
  return view.tab === 'needs' && view.selectedGoal === null && view.selectedPr === null;
}
