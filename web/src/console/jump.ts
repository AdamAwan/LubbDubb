// → docs/spec/17-cockpit.md#the-panes

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
