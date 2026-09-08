import type { JSX, ReactNode } from 'react';

// → docs/spec/17-cockpit.md#the-method-note-is-folded

export function MethodNote({ children, well = true }: { children: ReactNode; well?: boolean }): JSX.Element {
  return (
    <details className={well ? 'sp-method sp-well' : 'sp-method'}>
      <summary>How this is counted</summary>
      {children}
    </details>
  );
}
