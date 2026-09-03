import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

/**
 * The cockpit's button: one control that *does something when pressed*, in the
 * two families the cockpit draws and the four weights it means.
 *
 * It exists for the same reason [`Tag`](./tag.tsx) and the
 * [control kit](./controls.tsx) do, and the copy it replaced had drifted three
 * ways at once:
 *
 * - **`.cn-btn` rendered with no ground and no border.** `console.css` resets its
 *   own markup with `.cn button` at (0,1,1), which outranks a single class — so
 *   `.cn-btn.cn-primary` at (0,2,0) drew correctly while every plain `.cn-btn`
 *   beside it drew as bare text. The sheet was valid, every check was green, and
 *   the console had one button family on the screen in two shapes.
 * - **`AsyncButton` prepended `btn` unconditionally**, so a console-family async
 *   button went out as `class="btn cn-btn"`: two base families on one element,
 *   settled by source order rather than by anything anybody wrote down.
 * - **Tone travelled as a class string**, including *through props* —
 *   `buttonClass="ghost small"` — and half the sites that received one prefixed
 *   `btn` themselves while half did not (`HumanTaskActions.tsx`, two lines
 *   apart). A string cannot say which half it is.
 *
 * **The rules the button keeps:**
 *
 * - **Tone is a prop, never a class string.** `primary` for the one control a
 *   surface expects to be pressed, `danger` for one that destroys something, and
 *   no tone at all for a button that is neither. A caller cannot invent a fourth,
 *   and cannot spell one two ways.
 * - **Weight is `ghost`, not a third tone** — the same bargain [`Tag`](./tag.tsx)
 *   makes with `fill`. The quiet button and the ordinary one are the same box in
 *   the same colour and the ground is what ranks them, so a *destructive* button
 *   can also be a quiet one (`tone="danger" ghost`) without the two readings
 *   having to be spelled as one word. Written as a tone they could not combine,
 *   and `ConfirmButton`'s two quiet call sites would have had to give up their
 *   red to get their transparency.
 * - **One base class, chosen by `family`.** The shared sheet's `btn` or the
 *   console's `cn-btn` — never both, and never neither.
 * - **The two families stay two**, the same bargain `Tag` makes with `.cn-t-*`:
 *   `--accent` is orange and `--cn-accent` is blue, so this is one component over
 *   two vocabularies rather than a merge of them.
 * - **`className` carries shape, never tone.** A surface that needs its own
 *   geometry — a header row, a drop target, a close cross — passes that class
 *   beside the tone, which is the bargain the review mark already makes with
 *   `t-green`. What it may not pass is a weight the props already spell.
 *
 * {@link buttonClass} is the seam for the async components in
 * [`AsyncButton`](./AsyncButton.tsx) and [`ConfirmButton`](./ConfirmButton.tsx),
 * which own a lifecycle this component does not and must not: they resolve the
 * same class from the same props and add their own settled-flash ring.
 *
 * → docs/spec/17-cockpit.md#the-button
 */
type ButtonTone = 'primary' | 'danger';

/** Which sheet a button is drawn from. Omitted is the shared one. */
export type ButtonFamily = 'console';

/** The weights a button may be drawn at. Omitted is the ordinary one. */
export type ButtonSize = 'small';

/** The class vocabulary of one family: the base, the three tones, the one size. */
type Vocabulary = {
  base: string;
  tone: Record<ButtonTone, string>;
  ghost: string;
  small: string;
};

const SHARED: Vocabulary = {
  base: 'btn',
  tone: { primary: 'primary', danger: 'danger' },
  ghost: 'ghost',
  small: 'small',
};

const CONSOLE: Vocabulary = {
  base: 'cn-btn',
  tone: { primary: 'cn-primary', danger: 'cn-danger' },
  ghost: 'cn-ghost',
  small: 'cn-small',
};

/** What a button wears. The one place either family's class names are spelled. */
export type ButtonLook = {
  /** The hue: what pressing this does. Omitted is the button that is neither. */
  tone?: ButtonTone;
  /** The quiet weight — the same hue with no ground. Never a hue of its own. */
  ghost?: boolean;
  size?: ButtonSize;
  family?: ButtonFamily;
  /** Shape only — a surface's own geometry, never a weight the props spell. */
  className?: string;
};

/**
 * The class a button wears: its family's base, its tone, its size, and whatever
 * shape the surface owns.
 *
 * Exported for the async components, and for the handful of controls that are
 * *anchors* — a deep link into the operator's own Claude Code is a destination, so
 * `DesktopLink` draws an `<a>` and wears whichever row's tone it sits in, the same
 * seam `CONTROL_CLASS` is for the control kit. A surface that wants a button renders
 * {@link Button}; a surface that resolves this string itself is the class-string
 * drift this module exists to end.
 *
 * @public — the seam `AsyncButton`, `SubmitButton` and `ConfirmButton` share.
 */
export function buttonClass({ tone, ghost, size, family, className }: ButtonLook, ...extra: string[]): string {
  const vocab = family === 'console' ? CONSOLE : SHARED;
  const parts = [vocab.base];
  if (tone !== undefined) parts.push(vocab.tone[tone]);
  if (ghost === true) parts.push(vocab.ghost);
  if (size === 'small') parts.push(vocab.small);
  parts.push(...extra);
  if (className !== undefined) parts.push(className);
  return parts.filter((part) => part.length > 0).join(' ');
}

/**
 * The same look with a surface's own shape classes added.
 *
 * A station that embeds a shared control — `HumanTaskActions`, `ValidationSection`
 * — is handed the look by whoever placed it, and adds the geometry of its own row
 * on top: the `go` on the verb a row expects, the `no` on the one that refuses.
 * Those two halves used to be one interpolated string, which is how
 * `HumanTaskActions` came to prefix `btn` on three lines and not on three others.
 *
 * @public — the seam between a station's shape and its caller's tone.
 */
export function withShape(look: ButtonLook, ...shape: (string | false | null | undefined)[]): ButtonLook {
  const classes = [look.className, ...shape].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return classes.length === 0 ? look : { ...look, className: classes.join(' ') };
}

/**
 * One button that acts.
 *
 * `type="button"` is the default and is the point of it being a component: a
 * `<button>` inside a `<form>` submits it, and the cockpit's forms have their own
 * submit in {@link SubmitButton}. A surface that genuinely wants the form's
 * submit says so.
 */
export function Button({
  tone,
  ghost,
  size,
  family,
  className,
  children,
  ...rest
}: ButtonLook & { children: ReactNode } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'className' | 'children'
  >): JSX.Element {
  return (
    <button type="button" {...rest} className={buttonClass({ tone, ghost, size, family, className })}>
      {children}
    </button>
  );
}
