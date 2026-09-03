import type { JSX, ReactNode } from 'react';

/**
 * The cockpit's eyebrow: one small uppercase caption that says *what the thing
 * below it is*.
 *
 * It is the [tag](./tag.tsx)'s argument in the two properties nobody looks at
 * twice. An uppercase caption over a block, a table's column head, a tile's word
 * above its figure — one thing, and the two sheets drew it at forty different
 * font-size/letter-spacing pairs: 11px/0.04em, 11px/0.03em, 11px/0.5px,
 * 10.5px/0.7px, 9.5px/0.14em and on. Nobody chose those apart. Each is a call site
 * answering a question the sheet had never answered once, and the drift is visible
 * only to somebody holding two surfaces up together.
 *
 * **The rules the eyebrow keeps:**
 *
 * - **The ramp is two steps.** The section label, and `dense` — the smaller one,
 *   for a table's column heads and a stat tile's word, where the label sits in a
 *   grid of many and must not compete with the figures beside it. A third step
 *   would be a size somebody picked, which is the thing this replaces.
 * - **Face is a prop, never a class string.** `--muted` on the shared family and
 *   `--cn-fg-faint` on the console's, because those two families are a real
 *   distinction and not a namespace ([Tokens](../../../docs/spec/17-cockpit.md#tokens)).
 *   A caller cannot invent a third.
 * - **The ramp owns size, tracking, weight and case — never family or colour.**
 *   The review pack and the console draw their labels in mono and some want the
 *   brighter ink; those are one line on the surface's own rule, and folding them in
 *   here would be a third and fourth axis on a thing that has two.
 *
 * A label that has to be an element of its own — a `<th>`, a `<dt>`, an `<h4>` —
 * wears `lb` / `lb-sm` / `cn-lb` / `cn-lb-sm` directly rather than coming through
 * here. That is the same split [fields](../../../docs/spec/17-cockpit.md#fields)
 * make: the class is what reaches the labels that are structure, and the component
 * is what stops the ones that are markup drifting apart again.
 *
 * → docs/spec/17-cockpit.md#the-eyebrow
 */
export function Label({
  face,
  dense,
  title,
  children,
}: {
  /** Which family's ink. Omitted is the shared one. */
  face?: 'console';
  /** The smaller step: a column head, a tile's caption. */
  dense?: boolean;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  const base = face === 'console' ? 'cn-lb' : 'lb';
  return (
    <span className={dense === true ? `${base} ${base}-sm` : base} title={title}>
      {children}
    </span>
  );
}
