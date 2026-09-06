import type { JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md

export function Label({
  face,
  dense,
  title,
  children,
}: {
  face?: 'console';
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
