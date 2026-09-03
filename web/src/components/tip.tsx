import { useCallback, useRef, useState, type CSSProperties, type JSX, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/**
 * The cockpit's own hover card, for the marks that carry a reading too long to
 * draw on a row.
 *
 * **Not the browser's `title`**, which arrives a second late, cannot be styled,
 * and never arrives at all on a touch screen. This one opens on keyboard focus
 * too, so a glyph is never the only channel — the rule the review mark's
 * exception to `icons.tsx` is bought with.
 *
 * **One module rather than one per mark.** The placement below is measured rather
 * than declared, and every line of it is a bug somebody has already had: the two
 * marks that draw it sit in a rack hard against the right edge of the window and
 * in a masthead a few pixels under its top, so a second copy is a second chance
 * for one of them to be positioned against the wrong edge, or to be painted under
 * the rail at 55% opacity inside a row that made itself a stacking context.
 * → docs/spec/17-cockpit.md#the-tooltip-the-marks-share
 */

/** How wide the box is drawn — the measurement below has to agree with `.tip`. */
const TIP_WIDTH = 320;

/**
 * How little room below the anchor sends the box above it instead. A tooltip
 * grows downwards, so below is the default and above is the fallback — taken only
 * where there is no room below *and* there is more above.
 */
const TIP_ROOM = 220;

interface TipAnchor {
  /** Put this on the element the box is drawn from. */
  anchor: RefObject<HTMLElement | null>;
  /** Where the box goes, or `null` while it is closed. */
  at: CSSProperties | null;
  /** `onMouseEnter` / `onFocus`. */
  open: () => void;
  /** `onMouseLeave` / `onBlur`. */
  close: () => void;
}

/**
 * The measurement, and the open/closed state that goes with it.
 *
 * Fixed positioning rather than an absolutely-placed child, which any card that
 * clips its own overflow would cut in half; and re-measured on every open rather
 * than once, because the rack scrolls under the mark between hovers.
 */
export function useTip(): TipAnchor {
  const anchor = useRef<HTMLElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);

  const open = useCallback(() => {
    const box = anchor.current?.getBoundingClientRect();
    if (box === undefined) return;
    // From the mark's left edge, so the box opens *into* the page rather than
    // back across whatever the mark is annotating; from its right where that
    // would leave the window, which is the rack's rows.
    const left = Math.max(8, Math.min(box.left - 6, window.innerWidth - TIP_WIDTH - 8));
    const below = window.innerHeight - box.bottom;
    setAt(
      below < TIP_ROOM && box.top > below
        ? { left, bottom: window.innerHeight - box.top + 8, top: 'auto' }
        : { left, top: box.bottom + 8 },
    );
  }, []);

  const close = useCallback(() => setAt(null), []);

  return { anchor, at, open, close };
}

/**
 * The box itself, portalled to the body rather than drawn in place.
 *
 * `position: fixed` is not enough on its own: a closed pull request's row carries
 * `opacity: .55`, which is a stacking context, so the box was positioned against
 * the row rather than the window, painted under the rail's cards, and dimmed to
 * 55% along with everything else on the row. Out here it is neither.
 */
export function Tip({ at, children }: { at: CSSProperties; children: ReactNode }): JSX.Element {
  return createPortal(
    <span className="tip" style={at}>
      {children}
    </span>,
    document.body,
  );
}
