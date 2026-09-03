import type { JSX, ReactNode } from 'react';

/**
 * The cockpit's tag: one small, tinted, uppercase badge that says *what state a
 * thing is in*.
 *
 * It exists for the same reason the [control kit](./controls.tsx) does, one layer
 * down in the sheet. The tint of a tinted badge is three properties that have to
 * move together — the hue, the border that reads as the hue, and the ground it
 * sits on — and the cockpit had written that triple out by hand at twenty
 * separate class names. Not a tidiness problem: the copies had already drifted.
 * `rp-att-read` bordered in `--red-line` and `rp-v-false` in `--red` while both
 * called themselves "red", so two tags a hand's width apart on the review pack
 * were the same statement in two weights, and nothing said which was meant.
 *
 * **The rules the tag keeps:**
 *
 * - **Tone is a prop, never a class string.** `red` a fault, `amber` a gate,
 *   `green` a step after something landed, `blue` something to read, `accent` the
 *   one thing on a surface worth going to first, and no tone at all for a badge
 *   that is a label rather than a verdict. A caller cannot invent a seventh.
 * - **Weight is `fill`, not a second hue.** The outlined and the filled tag are
 *   the same box in the same colour; the ground is what ranks them. Opacity
 *   within one hue rather than a colour per weight, the same bargain the queue
 *   rail's `cn-parked` makes.
 * - **`dashed` is for the box that is not the plain case** — a region outside the
 *   diff being walked, a label a person overrode the checker on. It softens the
 *   edge without spending a second hue on the distinction.
 *
 * The tint itself lives in the sheet as the `.t-*` tone aliases, which set
 * `--tone`, `--tone-line` and `--tone-fill` from `:root` and nowhere else. That
 * is deliberately the *shared* family's mirror of the console's own `.cn-t-*`
 * aliases, not a merge of the two: `--accent` is orange and `--cn-accent` is
 * blue, so a console-family tag stays `cn-tag` under a `cn-t-*` row and is not
 * this component's business.
 *
 * → docs/spec/17-cockpit.md#the-tag
 */
export type TagTone = 'red' | 'amber' | 'green' | 'blue' | 'violet' | 'accent' | 'grey';

const TONE: Record<TagTone, string> = {
  red: 't-red',
  amber: 't-amber',
  green: 't-green',
  blue: 't-blue',
  violet: 't-violet',
  accent: 't-accent',
  grey: 't-grey',
};

/** One tinted badge. Tone, weight and the one shape the cockpit draws. */
export function Tag({
  tone,
  fill,
  dashed,
  lower,
  title,
  children,
}: {
  /** Omitted is the neutral tag: a label that carries no verdict. */
  tone?: TagTone;
  /** The filled weight — the same hue, ranked up by its ground. */
  fill?: boolean;
  /** The case that is not the plain one: an override, a region outside the diff. */
  dashed?: boolean;
  /** An id that gets typed back, drawn as its author wrote it. */
  lower?: boolean;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  const cls = ['tag'];
  if (tone !== undefined) cls.push(TONE[tone]);
  if (fill === true) cls.push('tag-fill');
  if (dashed === true) cls.push('tag-dashed');
  if (lower === true) cls.push('tag-lower');
  return (
    <span className={cls.join(' ')} title={title}>
      {children}
    </span>
  );
}
