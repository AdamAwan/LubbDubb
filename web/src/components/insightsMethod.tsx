import type { JSX, ReactNode } from 'react';
import { Collapsible } from './collapsible.js';

// → docs/spec/17-cockpit.md#the-method-note-is-folded

export function MethodNote({ children, well = true }: { children: ReactNode; well?: boolean }): JSX.Element {
  return (
    <Collapsible subject="insights" className={well ? 'sp-method sp-well' : 'sp-method'} title="How this is counted">
      {children}
    </Collapsible>
  );
}
