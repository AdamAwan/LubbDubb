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
 * **One frame, one ground, one corner.** The first collapse kept a `face` prop —
 * `shared` or `console`, the two token families — and a `roomy` inset beside the
 * ordinary one, on the argument that each was a real distinction. Neither held:
 *
 * - **Every frame in the cockpit renders inside the console.** The four call sites
 *   that named the shared face — the escalation card, the recovery banner, a pet
 *   card, a species card — are drawn by `NeedsBand`, `ConsoleRoot` and the two Pets
 *   surfaces, all of them under `.cn`. So `face` never chose between two grounds a
 *   frame might sit on; it chose whether a card would be two steps lighter and
 *   square where every card around it was `--cn-panel` and rounded. The families
 *   stay a real distinction where they draw on different grounds — a drawer and a
 *   modal are mounted outside the console — but that is `Modal`'s business, not a
 *   box's. The frame draws `--cn-panel` because that is where every frame is.
 * - **`roomy` was one call site, 4px from `snug`.** A step used once is not a ramp;
 *   `flush` versus padded is structural — whether the frame or its children own the
 *   inset, which is what a full-bleed header band needs — and "10px or 14px" is not
 *   a decision anybody can take on principle. Two steps, and the second inset went
 *   with the prop: `--pad` is the frame's inset, and a second one is a token
 *   somebody adds on purpose.
 * - **`as='section'` bought nothing.** A `<section>` is a landmark only with an
 *   accessible name, and the frame passed none — thirteen call sites were asking
 *   for a generic element with a different tag name, and no rule in either sheet
 *   selected on it.
 *
 * What is left is one variation, and it earns its keep: **who owns the inset.**
 *
 * **`className` is a modifier, never a second face.** What the frame *is* stays
 * with the call site — a tint on a card that wants attention, a column layout, an
 * `overflow: hidden` — and every one of those rules already outranks the base.
 *
 * {@link HeadRow} is the same argument for the row across the top of one: flex,
 * centred, 8px, wrapping was the single most duplicated declaration set in the
 * sheet. Alignment is the one axis that genuinely varied — `baseline` where the
 * row is words of two sizes rather than boxes — and it is the only prop.
 *
 * → docs/spec/17-cockpit.md#the-frame
 */
export function Panel({ density, className, children }: PanelProps): JSX.Element {
  const cls = ['pl'];
  if (density === 'padded') cls.push('pl-pad');
  if (className !== undefined) cls.push(className);
  return <div className={cls.join(' ')}>{children}</div>;
}

interface PanelProps {
  /** Who owns the inset: `flush` where the frame's own children carry it. */
  density: 'flush' | 'padded';
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
