import type { JSX } from 'react';

// → docs/spec/17-cockpit.md

export function Who({ name }: { name: string | null }): JSX.Element {
  if (name === null) {
    return (
      <span className="cn-who cn-who-none" title="The harness opened this" aria-hidden="true">
        ◇
      </span>
    );
  }
  const mark = initials(name);
  if (mark === null) {
    return (
      <span className="cn-who cn-who-none" role="img" aria-label={name} title={name}>
        ◇
      </span>
    );
  }
  return (
    <span className="cn-who cn-who-person" role="img" aria-label={name} title={name}>
      {mark}
    </span>
  );
}

export function initials(name: string): string | null {
  const local = (name.trim().split('@')[0] ?? '').trim();
  const words = local.split(/[\s._+\-/\\]+/).filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return null;
  const last = words[words.length - 1] ?? first;
  const taken = words.length > 1 ? [...first].slice(0, 1).concat([...last].slice(0, 1)) : [...first].slice(0, 2);
  const kept = taken.filter((char) => /[\p{L}\p{N}]/u.test(char)).join('');
  return kept === '' ? null : kept.toUpperCase();
}
