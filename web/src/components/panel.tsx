import type { JSX, ReactNode } from 'react';

/**
 * The cockpit's frame, and the row a surface's head sits in.
 *
 * A card, a panel and a tile are one idea — a bordered box, on a raised ground,
 * with something inside it — and the cockpit had written that idea out at some
 * thirty class names. Not a tidiness problem: the copies had already drifted past
 * the point where a name told you what you were getting. Padding ran 6px 8px,
 * 8px 10px, 9px 10px, 8px 12px and 14px 16px with nothing choosing between them;
 * the radius alternated between three named steps and bare `4px`, `7px` and
 * `20px` literals, which are corners [the Theme section](../cockpit/tokens.ts)
 * cannot reach; and `.finding-card` and `.lesson-card` had become the same five
 * declarations twice, under two names, with no live call site left on either.
 *
 * **The rules it keeps:**
 *
 * - **Density is a step, never a value.** `flush` for a frame whose children pad
 *   themselves — a card with a header band — `snug` for the ordinary one, `roomy`
 *   for a frame that is the page's subject. Three steps, on `--pad-*`, so a
 *   fourth padding is a decision somebody has to make on purpose.
 * - **The face is a prop, never a class string** — the precedent
 *   [`Modal`](./Modal.tsx) sets. The `--cn-*` console family and the shared family
 *   are a real distinction rather than a namespace
 *   ([17](../../../docs/spec/17-cockpit.md#tokens)): `--panel` sits two steps
 *   lighter than `--cn-panel`, and each family keeps its own radius step. A caller
 *   names which one it is drawing, and neither sheet learns the other's names.
 * - **A radius is its family's step.** `--r-md` for the shared face, `--cn-r` for
 *   the console's, and no frame writes a length. A literal here is the same
 *   failure a colour literal is — square everywhere is the operator's setting, and
 *   a hard `7px` is a corner no setting moves.
 * - **`className` is a modifier, never a second face.** What the frame *is* stays
 *   with the call site — a tint on a card that wants attention, a column layout,
 *   an `overflow: hidden` — and every one of those rules already outranks the base.
 *
 * {@link HeadRow} is the same argument for the row across the top of one: flex,
 * centred, 8px, wrapping was the single most duplicated declaration set in the
 * sheet. Alignment is the one axis that genuinely varied — `baseline` where the
 * row is words of two sizes rather than boxes — and it is the only prop.
 *
 * → docs/spec/17-cockpit.md#the-frame
 */
export function Panel({ face, density, as, className, children }: PanelProps): JSX.Element {
  const Element = as ?? 'div';
  const cls = ['pl'];
  if (face === 'console') cls.push('pl-cn');
  if (density !== 'flush') cls.push(density === 'roomy' ? 'pl-roomy' : 'pl-snug');
  if (className !== undefined) cls.push(className);
  return <Element className={cls.join(' ')}>{children}</Element>;
}

interface PanelProps {
  /** Which token family the frame draws in — never which colours. */
  face: 'shared' | 'console';
  /** `flush` where the frame's own children carry the inset. */
  density: 'flush' | 'snug' | 'roomy';
  /** `section` where the frame is a landmark rather than a box. */
  as?: 'div' | 'section';
  /** A modifier on the frame — `cfg-pending`, `cn-fb-wants` — never a second face. */
  className?: string;
  children?: ReactNode;
}

/**
 * The row across the top of a surface: its name, and what it is in.
 *
 * `align` is `center` for a row of boxes and `baseline` for a row of words, which
 * is the whole of the difference between the eleven copies this replaced.
 */
export function HeadRow({
  align,
  className,
  children,
}: {
  align?: 'center' | 'baseline';
  /** What this particular head is — `pm-head`, `pool-bar`. */
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const cls = ['hdr'];
  if (align === 'baseline') cls.push('hdr-base');
  if (className !== undefined) cls.push(className);
  return <div className={cls.join(' ')}>{children}</div>;
}
