import type { JSX, ReactNode } from 'react';

/**
 * The cockpit's tag: **the** small tinted box. There is one, and this is it.
 *
 * The cockpit had twenty-one of these. Two vocabularies of shape — a pill in the
 * UI face and sentence case, a square one in mono and uppercase — and inside each,
 * a family per surface: `.chip`, `.badge`, `.cn-chip`, `.cn-tag`, `.pm-dtag`,
 * `.rm-tag`, `.tickets-state`, `.tickets-type`, `.ob-state` and the rest. Not a
 * tidiness problem: the copies had drifted. `.badge.interrupted` was declared
 * twice, a thousand lines apart, in two different colours; `.badge.crashed` took
 * its ground from one family's red and its ink from the other's; three separate
 * ambers said "somebody has to look at this" in three weights, and nothing said
 * which was meant.
 *
 * **The rules the tag keeps:**
 *
 * - **One shape.** Square, uppercase, mono — no size prop, no pill, no second
 *   face. The shape is not a decision a call site gets to make, which is what
 *   stops a twenty-second family.
 * - **Tone is a prop, never a class string.** `red` a fault, `amber` a gate,
 *   `green` a step after something landed, `blue` something to read, `violet` a
 *   person or a container, `accent` the one thing on a surface worth going to
 *   first, `grey` a label rather than a verdict — and no tone at all for a badge
 *   that carries no verdict. A caller cannot invent an eighth.
 * - **One palette.** The tones name `--cn-*` and nothing else, on every surface.
 *   The two hue families still exist for everything that is not a tag — a lamp, a
 *   band header, a rail's edge — but a red tag is one red, and `accent` is the
 *   console's blue rather than the page's orange, because a tag that changed hue
 *   when it moved between surfaces was the drift this replaced.
 * - **Weight is `fill`, not a second hue.** The outlined and the filled tag are
 *   the same box in the same colour; the ground is what ranks them. Opacity within
 *   one hue rather than a colour per weight, the same bargain the queue rail's
 *   `cn-parked` makes.
 * - **`dashed` is for the box that is not the plain case** — a region outside the
 *   diff being walked, a tracker's copy that has gone stale, a label a person
 *   overrode the checker on.
 * - **`lower` is for an id that gets typed back.** These are lowercase kebab-case
 *   and the tag's own uppercase would be a lie about the one string on the surface
 *   that has to be copied exactly.
 *
 * The tint lives in the sheet as the `.t-*` tone aliases, which set `--tone`,
 * `--tone-line` and `--tone-fill` from `:root` and nowhere else — a declaration on
 * a tone class shadows an inherited one unconditionally, so a value written there
 * is a tint no theme can reach inside a tone. `test/cockpitTheme.test.ts` holds
 * that shut.
 *
 * **The alias is reusable without the component**, and a few surfaces take it that
 * way: an element that is a `<button>`, or that carries a colour the operator
 * chose, wears `tag` and a `t-*` beside its own class rather than coming through
 * here. What it gives up is the copy of the triple, which is the thing that drifts.
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
