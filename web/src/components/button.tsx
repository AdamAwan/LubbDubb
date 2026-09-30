import type { AnchorHTMLAttributes, ButtonHTMLAttributes, JSX, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react';
import type { ControlUsage } from '../types.js';
import { logControl } from '../cockpit/usage.js';

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
 * Exported for the async components, which compose their lifecycle classes onto
 * it. An anchor that wears the look draws through `LinkButton` instead, so it
 * cannot skip its usage event.
 *
 * The base is written twice on purpose. `.btn.btn` in `styles.css` is what
 * survives `console.css`'s `.cn button` reset, and it only survives if the markup
 * carries the class twice as well.
 *
 * @public — the seam `AsyncButton`, `SubmitButton` and `ConfirmButton` share.
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
 * The verb a row expects, and the one that refuses — the two readings a station
 * composes on top of whatever tone its caller passed.
 *
 * They were `withShape(look, 'go')` and `'no'`, class names on the markup with
 * **no rule behind either of them** in any sheet. So the one thing the design
 * system had for saying "this is the act" rendered as nothing, and `Done` drew
 * identically to `Decline` on every surface that embeds the row: the operator
 * was given two grey buttons and no way to tell which one the row was asking
 * for. They were spelled as shape, which is why nobody noticed the rule was
 * missing — shape is the station's geometry and is allowed to be a class, and
 * these were never geometry.
 *
 * Tone is a prop, never a class string, so they are tones now — and the rule
 * they resolve to is already written, once, in the `.btn` block.
 * → docs/spec/17-cockpit.md#the-button
 */
export function expected(look: ButtonLook): ButtonLook {
  return { ...look, tone: 'primary' };
}

export function refusing(look: ButtonLook): ButtonLook {
  return { ...look, tone: 'danger' };
}

export type Usage = { usage: ControlUsage };

export type Destination = Usage & { go: () => void };

/**
 * The one element in the cockpit that draws a `<button>`, and it wears no look.
 * Every other button renders through it, so a control nobody named a usage event
 * for does not compile. → docs/spec/34-usage-metrics.md#every-button-names-its-event
 */
export function BareButton({
  usage,
  logs = true,
  type = 'button',
  onClick,
  buttonRef,
  ...rest
}: Usage & { logs?: boolean; type?: 'button' | 'submit'; buttonRef?: Ref<HTMLButtonElement> } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'type'
  >): JSX.Element {
  return (
    <button
      type={type}
      ref={buttonRef}
      {...rest}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (logs) logControl(usage);
        onClick?.(event);
      }}
    />
  );
}

/**
 * What a press of a control that leaves the cockpit is: always a `ui` event, and
 * always `open` — nothing in the harness records a page opened elsewhere.
 * → docs/spec/34-usage-metrics.md#a-control-that-is-not-a-button
 */
export type OpenUsage = Extract<ControlUsage, `${string}.open`>;

/**
 * The one element that draws an `<a>` a person presses as a control — a deep link
 * into the operator's Claude Code, an external page worn as a button.
 */
export function BareLink({
  usage,
  onClick,
  ...rest
}: { usage: OpenUsage } & AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  return (
    <a
      {...rest}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        logControl(usage);
        onClick?.(event);
      }}
    />
  );
}

export function LinkButton({
  tone,
  ghost,
  size,
  className,
  ...rest
}: ButtonLook & { usage: OpenUsage } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'className'>): JSX.Element {
  return <BareLink className={buttonClass({ tone, ghost, size, className })} {...rest} />;
}

/**
 * A button inside an `<svg>`, where a `<button>` cannot be drawn: a `<g>` that
 * takes the press from the mouse and the keyboard alike, and logs it.
 */
export function SvgButton({
  usage,
  onPress,
  className,
  children,
}: Usage & { onPress: () => void; className?: string; children: ReactNode }): JSX.Element {
  const press = (): void => {
    logControl(usage);
    onPress();
  };
  return (
    <g
      className={className}
      role="button"
      tabIndex={0}
      onClick={press}
      onKeyDown={(event: KeyboardEvent<SVGGElement>) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          press();
        }
      }}
    >
      {children}
    </g>
  );
}

export function Button({
  tone,
  ghost,
  size,
  className,
  children,
  ...rest
}: ButtonLook &
  Usage & { logs?: boolean; children: ReactNode } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'className' | 'children' | 'type'
  >): JSX.Element {
  return (
    <BareButton {...rest} className={buttonClass({ tone, ghost, size, className })}>
      {children}
    </BareButton>
  );
}

/**
 * A row of buttons, which is a thing rather than a `div` each surface arranges
 * for itself.
 *
 * The cockpit had at least three spellings of it — `.cn-acts` in the console,
 * the feature board's own, and a bare flex row wherever somebody needed two
 * controls side by side — which is the same drift `.cn-btn` was, one level up:
 * the button was settled and the group it sits in was not, so the gap between
 * two controls depended on which surface you were looking at.
 *
 * `bar` is the group at the foot of something it settles — an ask, a form. It
 * takes a rule above it and the room to go with it, so the controls read as the
 * end of that thing rather than as the last paragraph of it. It is a property of
 * the group, not of the surface: the row that answers an ask wants the same
 * treatment on the rail, in the ask panel and on the overview, and a selector
 * scoped to one of those three is how the other two drift.
 */
export function ButtonRow({
  bar,
  className,
  children,
}: {
  bar?: boolean;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const parts = ['btn-row', ...(bar === true ? ['bar'] : []), ...(className === undefined ? [] : [className])];
  return <div className={parts.join(' ')}>{children}</div>;
}
