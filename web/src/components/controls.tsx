import { createContext, useContext, type JSX, type ReactNode } from 'react';
import { Icon } from './icons.js';

// → docs/spec/17-cockpit.md

export const CONTROL_CLASS = 'cn-tgl';

const ControlRow = createContext(false);

/**
 * Whether the caller is being drawn inside a control row.
 *
 * @public — the seam the link components (`DesktopLink`) read so a row's kit is
 * the row's answer rather than something every call site has to remember.
 */
export function useInControlRow(): boolean {
  return useContext(ControlRow);
}

type Tone = 'on' | 'primary' | 'danger';

const TONE: Record<Tone, string> = {
  on: 'cn-tglon',
  primary: 'cn-tglprim',
  danger: 'cn-danger',
};

function toneClass(tone: Tone | undefined, base = CONTROL_CLASS): string {
  return tone === undefined ? base : `${base} ${TONE[tone]}`;
}

export function ControlBar({ children }: { children: ReactNode }): JSX.Element {
  return <div className="cn-ctlbar">{children}</div>;
}

export function ControlGroup({
  caption,
  icon,
  divider,
  children,
}: {
  caption: string;
  icon: Parameters<typeof Icon>[0]['name'];
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
        <span className="cn-ctlrow">
          <ControlRow.Provider value={true}>{children}</ControlRow.Provider>
        </span>
      </span>
    </>
  );
}

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

export function ControlSegments({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className="cn-ctlseg" role="group" aria-label={label}>
      {children}
    </span>
  );
}

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

export function ControlSelect({
  icon,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  children: ReactNode;
}): JSX.Element {
  return (
    <span className="cn-ctlsel">
      <Icon name={icon} />
      {children}
    </span>
  );
}
