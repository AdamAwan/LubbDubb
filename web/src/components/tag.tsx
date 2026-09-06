import type { JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md

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

export function Tag({
  tone,
  fill,
  dashed,
  lower,
  title,
  children,
}: {
  tone?: TagTone;
  fill?: boolean;
  dashed?: boolean;
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
