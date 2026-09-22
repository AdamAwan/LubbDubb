// → docs/spec/17-cockpit.md#the-panes
import type { CockpitActions } from '../cockpit/actions.js';
import type { NeedKind } from '../view/needsYou.js';
import { GOAL_ASK_TAB } from '../view/goalPage.js';

/**
 * Scroll a card of the goal page into view, after the pane that holds it has had a
 * chance to render.
 *
 * Two frames rather than one, and that is the whole of why this is a function
 * rather than a `scrollIntoView` at each call site: the press that lands here
 * usually changes the pane in the same tick, so the element is not in the document
 * when the handler runs. One frame gets React's commit; the second gets the layout
 * it produced. A press that scrolled too early finds nothing and reads as a control
 * that does nothing at all.
 *
 * @public shared by the track strip, the pane jumps and the ask that leads to the reveal gate
 */
export function scrollToAnchor(anchor: string): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  });
}

/**
 * The goal an ask is about, opened on the pane that ask is answered in.
 *
 * `selectGoal` alone carries no pane, so the goal page falls back to its landing
 * rule — which reads the goal's lifecycle and not the press, and sends a goal
 * whose checks have begun to Validate however the ask was about its plan. The
 * pane comes from the same map that puts the ask's dot on the navigation, so
 * where the dot says the ask is and where the press lands cannot disagree; a kind
 * about the goal as a whole has no pane and leaves the landing to the rule.
 * → docs/spec/17-cockpit.md#which-pane-opens
 *
 * @public shared by the rail, the ask panel and the focus overview
 */
export function openGoalForAsk(actions: CockpitActions, ref: string, kind: NeedKind): void {
  const pane = GOAL_ASK_TAB[kind];
  if (pane === null) actions.selectGoal(ref);
  else actions.openGoalPane(ref, pane);
}
