import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

/**
 * The cockpit's button: **one** control that does something when pressed, drawn
 * one way everywhere in the app.
 *
 * It exists for the same reason [`Tag`](./tag.tsx) and the
 * [control kit](./controls.tsx) do, and the copy it replaced had drifted four
 * ways at once:
 *
 * - **There were two button families.** The shared sheet's `.btn` and the
 *   console's `.cn-btn` were two vocabularies for the same four readings, and they
 *   had already parted company on shape, radius and accent: a 7px steel-blue
 *   primary in a modal and a 4px vivid-blue one on the goal page, both called
 *   "primary", with nothing saying which was meant.
 * - **`.cn-btn` rendered with no ground and no border.** `console.css` resets its
 *   own markup with `.cn button` at (0,1,1), which outranks a single class — so
 *   `.cn-btn.cn-primary` at (0,2,0) drew correctly while every plain console
 *   button beside it drew as bare text. That reset is *why* the second family
 *   grew; `.btn.btn` answers it at the source, so one rule now dresses a button
 *   wherever it sits.
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
 * - **One button, one look.** There is no family, no surface variant and no
 *   opt-out. A primary button is the same button in a modal, on the config page
 *   and on a console card, because those are the same act.
 * - **Tone is a prop, never a class string.** `primary` for the one control a
 *   surface expects to be pressed, `danger` for one that destroys something,
 *   `secondary` — the default — for everything else. A caller cannot invent a
 *   fourth, and cannot spell one two ways.
 * - **Weight is `ghost`, not a third tone** — the same bargain `Tag` makes with
 *   `fill`. The quiet button and the ordinary one are the same box in the same
 *   colour and the ground is what ranks them, so a *destructive* button can also
 *   be a quiet one (`tone="danger" ghost`) without the two readings having to be
 *   spelled as one word. Written as a tone they could not combine, and
 *   `ConfirmButton`'s two quiet call sites would have had to give up their red to
 *   get their transparency.
 * - **`className` carries shape, never tone.** A surface that needs its own
 *   geometry — a header row, a drop target, a close cross — passes that class
 *   beside the tone, which is the bargain the review mark already makes with
 *   `t-green`. What it may not pass is a weight the props already spell.
 *
 * {@link buttonClass} is the seam for the components that are not buttons: the
 * async ones in [`AsyncButton`](./AsyncButton.tsx) and
 * [`ConfirmButton`](./ConfirmButton.tsx), which own a lifecycle this component
 * does not, and `DesktopLink`, which is an `<a>` because a deep link is a
 * destination.
 *
 * → docs/spec/17-cockpit.md#the-button
 */
type ButtonTone = 'primary' | 'secondary' | 'danger';

/** The weights a button may be drawn at. Omitted is the ordinary one. */
export type ButtonSize = 'small';

/**
 * The modifier each tone wears. `secondary` is the plain button and carries no
 * class of its own — it is spelled anyway, because a caller who means "the quiet
 * one beside the primary" should be able to say so rather than say nothing.
 */
const TONE: Record<ButtonTone, string> = {
  primary: 'primary',
  secondary: '',
  danger: 'danger',
};

/** What a button wears. The one place the button's class names are spelled. */
export type ButtonLook = {
  /** What pressing this does. Omitted is `secondary`. */
  tone?: ButtonTone;
  /** The quiet weight — the same tone with no ground. Never a tone of its own. */
  ghost?: boolean;
  size?: ButtonSize;
  /** Shape only — a surface's own geometry, never a weight the props spell. */
  className?: string;
};

/**
 * The class a button wears: the base, its tone, its size, and whatever shape the
 * surface owns.
 *
 * Exported for the async components, and for the handful of controls that are
 * *anchors* — a deep link into the operator's own Claude Code is a destination, so
 * `DesktopLink` draws an `<a>` and wears the button's look through this, the same
 * seam `CONTROL_CLASS` is for the control kit.
 *
 * The base is written twice on purpose. `.btn.btn` in `styles.css` is what
 * survives `console.css`'s `.cn button` reset, and it only survives if the markup
 * carries the class twice as well.
 *
 * @public — the seam `AsyncButton`, `SubmitButton`, `ConfirmButton` and
 * `DesktopLink` share.
 */
export function buttonClass({ tone, ghost, size, className }: ButtonLook, ...extra: string[]): string {
  const parts = ['btn', 'btn'];
  if (tone !== undefined) parts.push(TONE[tone]);
  if (ghost === true) parts.push('ghost');
  if (size === 'small') parts.push('small');
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
 * submit in `SubmitButton`. A surface that genuinely wants the form's submit says
 * so.
 */
export function Button({
  tone,
  ghost,
  size,
  className,
  children,
  ...rest
}: ButtonLook & { children: ReactNode } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'className' | 'children'
  >): JSX.Element {
  return (
    <button type="button" {...rest} className={buttonClass({ tone, ghost, size, className })}>
      {children}
    </button>
  );
}
