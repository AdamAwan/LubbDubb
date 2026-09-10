import type { JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md

/**
 * `captured` is a meaning rather than a hue name, and deliberately: it is the one state whose colour
 * must not be any of the six already spoken for — not amber, which means *still owed and nobody has
 * started*, and not green, which means *it passed*. A screen waiting to be looked at is neither.
 * → docs/spec/36-remote-validation.md#handing-a-screen-back-to-look-at
 */
export type TagTone = 'red' | 'amber' | 'green' | 'blue' | 'violet' | 'accent' | 'grey' | 'captured';

const TONE: Record<TagTone, string> = {
  red: 't-red',
  amber: 't-amber',
  green: 't-green',
  blue: 't-blue',
  violet: 't-violet',
  accent: 't-accent',
  grey: 't-grey',
  captured: 't-captured',
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
