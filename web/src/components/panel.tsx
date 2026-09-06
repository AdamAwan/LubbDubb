import type { JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md

export function Panel({ density, className, children }: PanelProps): JSX.Element {
  const cls = ['pl'];
  if (density === 'padded') cls.push('pl-pad');
  if (className !== undefined) cls.push(className);
  return <div className={cls.join(' ')}>{children}</div>;
}

interface PanelProps {
  density: 'flush' | 'padded';
  className?: string;
  children?: ReactNode;
}

export function HeadRow({
  align,
  className,
  children,
}: {
  align?: 'center' | 'baseline';
  className?: string;
  children?: ReactNode;
}): JSX.Element {
  const cls = ['hdr'];
  if (align === 'baseline') cls.push('hdr-base');
  if (className !== undefined) cls.push(className);
  return <div className={cls.join(' ')}>{children}</div>;
}
