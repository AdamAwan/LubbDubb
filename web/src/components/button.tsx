import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md

type ButtonTone = 'primary' | 'secondary' | 'danger';

export type ButtonSize = 'small';

const TONE: Record<ButtonTone, string> = {
  primary: 'primary',
  secondary: '',
  danger: 'danger',
};

export type ButtonLook = {
  tone?: ButtonTone;
  ghost?: boolean;
  size?: ButtonSize;
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
