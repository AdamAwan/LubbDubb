import type { JSX } from 'react';
import type { AgentFlag } from '../types.js';
import { artifactHref } from './util.js';

// → docs/spec/17-cockpit.md

export function FlagChips({
  flags,
  artifactUrls,
}: {
  flags: AgentFlag[] | undefined;
  artifactUrls: Record<string, string>;
}): JSX.Element | null {
  if (!flags || flags.length === 0) return null;
  return (
    <div className="flag-chips">
      {flags.map((f) => (
        <a
          key={f.id}
          className="tag t-blue flag-chip"
          href={artifactHref(f, artifactUrls)}
          target="_blank"
          rel="noopener noreferrer"
          title={`${f.kind}: ${f.ref}`}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="flag-chip-kind">{f.kind}</span>
          {f.label}
        </a>
      ))}
    </div>
  );
}
