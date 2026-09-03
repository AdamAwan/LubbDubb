import type { JSX, ReactNode } from 'react';
import { Icon } from './icons.js';

/**
 * The cockpit's control kit: one button, one link, one dropdown, one group of
 * grouped buttons, and the captioned group they sit in.
 *
 * It exists because the goal header proved what happens without it. Nine controls
 * were hand-written as class strings — `cn-tgl`, `cn-tgl cn-danger`,
 * `cn-tgl ${on ? 'cn-watch' : ''}` — and three separate faults rode along
 * invisibly: `.cn button { font: inherit }` outranks a bare class, so the
 * controls that were buttons drew a size larger than the ones that were links;
 * the "on" tint reused `cn-watch`, which is also an environments *card*, whose
 * margin and left border came with it; and a `<select>` sized itself from the
 * same padding to a different height, because the platform draws it. Every one of
 * those is a class string being asked to remember something. A component
 * remembers it once.
 *
 * **The rules the kit keeps:**
 *
 * - **One height, one edge, one size.** Whatever element a control is built from,
 *   it is 28px tall with the same border, radius, padding and 11.5px lettering.
 * - **Tone is a prop, never a class string.** `on` for a toggle that is engaged,
 *   `primary` for the one control a surface expects to be pressed, `danger` for
 *   one that destroys something. A caller cannot invent a fourth.
 * - **An icon never appears without its label** ([`Icon`](./icons.tsx)). The glyph
 *   finds the control faster for somebody who already knows the row; it is not the
 *   name of it.
 * - **A caption explains a group, not a control.** `ControlGroup` is what answers
 *   "how is this one different from that one" once, for everything under it, which
 *   is what lets the labels stay short.
 *
 * `CONTROL_CLASS` is the seam for the components that already take a `className` —
 * `DesktopLink`, `TicketLink`, `PrLink` — so a deep link wears the kit's tone
 * without the kit having to know how a ref resolves. It is `cn-tgl`, the class the
 * pull-request page and the human-task actions already wear, so adopting the kit
 * is a change of *who writes the class*, never a second control family beside the
 * one the cockpit has.
 *
 * → docs/spec/17-cockpit.md#the-control-kit
 */
export const CONTROL_CLASS = 'cn-tgl';

/** What a control is *for*, in the three readings the cockpit actually draws. */
type Tone = 'on' | 'primary' | 'danger';

const TONE: Record<Tone, string> = {
  on: 'cn-tglon',
  primary: 'cn-tglprim',
  danger: 'cn-danger',
};

/** The class a control wears: the kit's base, its tone, and nothing else. */
function toneClass(tone: Tone | undefined, base = CONTROL_CLASS): string {
  return tone === undefined ? base : `${base} ${TONE[tone]}`;
}

/**
 * The row a surface's controls sit in. Groups wrap as units, never through one.
 */
export function ControlBar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="cn-ctlbar">{children}</div>;
}

/**
 * A captioned group of controls, and the rule between it and the next.
 *
 * The caption is the kit's whole argument: a control named for what it does still
 * cannot say what *kind* of thing it is, and a header of nine such names is read
 * one control at a time. `divider` draws the rule *before* the group, so a bar
 * states its own seams rather than each group guessing.
 */
export function ControlGroup({
  caption,
  icon,
  divider,
  children,
}: {
  caption: string;
  icon: Parameters<typeof Icon>[0]['name'];
  /** Draw the rule that separates this group from the one before it. */
  divider?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <>
      {divider === true && <i className="cn-ctlsep" />}
      <span className="cn-ctlgrp">
        <span className="cn-ctlcap">
          <Icon name={icon} size={11} />
          {caption}
        </span>
        <span className="cn-ctlrow">{children}</span>
      </span>
    </>
  );
}

/**
 * One control that acts. `count` is drawn as a pill rather than a second
 * sentence — how many instructions already stand belongs on the control that
 * adds one.
 */
export function ControlButton({
  icon,
  tone,
  count,
  title,
  onClick,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  tone?: Tone;
  count?: number;
  title: string;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button type="button" className={toneClass(tone)} onClick={onClick} title={title}>
      <Icon name={icon} />
      {children}
      {count !== undefined && count > 0 && <i className="cn-ctlcount">{count}</i>}
    </button>
  );
}

/**
 * Grouped buttons: mutually exclusive states of one thing, sharing an edge.
 *
 * Sharing the edge is the whole statement — these are alternatives, not separate
 * things you might do — and the pressed one carries a ground rather than a
 * border, so which state a thing is in reads without pressing anything.
 */
export function ControlSegments({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className="cn-ctlseg" role="group" aria-label={label}>
      {children}
    </span>
  );
}

/**
 * One state within {@link ControlSegments}.
 *
 * A segment that cannot be reached is drawn `inert` rather than dropped: a state
 * that vanishes on being reached leaves the control claiming the thing is still
 * in the state before it.
 */
export function ControlSegment({
  icon,
  tone,
  pressed,
  inert,
  title,
  onClick,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  tone?: Tone;
  pressed?: boolean;
  inert?: boolean;
  title: string;
  onClick?: () => void;
  children: ReactNode;
}): JSX.Element {
  const cls = toneClass(tone, 'cn-ctlsegb');
  if (inert === true) {
    return (
      <span className={cls} aria-disabled="true" title={title}>
        <Icon name={icon} />
        {children}
      </span>
    );
  }
  return (
    <button type="button" className={cls} aria-pressed={pressed === true} onClick={onClick} title={title}>
      <Icon name={icon} />
      {children}
    </button>
  );
}

/**
 * The chrome a `<select>` wears to sit in a control row: the kit's glyph on the
 * left, its own caret on the right, and the platform's rendering off.
 *
 * A wrapper rather than a select of its own, so the pickers that own the options
 * — `ProfilePicker` and whatever follows it — keep owning them, and only the way
 * the control *looks* is answered here.
 */
export function ControlSelect({
  icon,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  /** The `<select>` itself, from whichever picker owns those options. */
  children: ReactNode;
}): JSX.Element {
  return (
    <span className="cn-ctlsel">
      <Icon name={icon} />
      {children}
    </span>
  );
}
