import type { JSX } from 'react';
import type { AgentFlag } from '../types.js';
import { artifactHref } from './util.js';

/**
 * The artifacts an agent surfaced mid-run (design docs, reports, links) as a row
 * of clickable chips. Each opens in a new tab — a local path through the confined
 * artifact route, an http(s) ref directly. Renders nothing when there are none.
 */
export function FlagChips({ flags }: { flags: AgentFlag[] | undefined }): JSX.Element | null {
  if (!flags || flags.length === 0) return null;
  return (
    <div className="flag-chips">
      {flags.map((f) => (
        <a
          key={f.id}
          className="chip small flag-chip"
          href={artifactHref(f.agentId, f.ref)}
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
