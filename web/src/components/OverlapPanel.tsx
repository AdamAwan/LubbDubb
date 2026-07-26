import type { JSX } from 'react';
import type { FileOverlap } from '../types.js';
import { refLink, relTime, statusDot } from './util.js';

/**
 * Paths two agents wrote while both were running.
 *
 * This is the one collision class the dispatcher cannot see. Its gates are keyed
 * on what it dispatches — a branch, an origin, a plan's part budget — and they
 * are complete for that; what they cannot cover is what an agent does once it is
 * running. Two agents on two branches, each within its own gate, both editing the
 * same file: git reports it only if the hunks collide, and when they don't the
 * second merge quietly undoes or duplicates the first.
 *
 * Nothing here is advisory or agent-declared. Every row is derived from the
 * file-events hook's record of what was actually written, so it holds for agents
 * that know nothing about it and for a fleet running with the tool channel off.
 * The panel is diagnostic by design — it names the collision and leaves the call
 * to the operator, who is the only one who can tell "both had to touch the barrel
 * file" from "these two are writing the same feature twice".
 */
export function OverlapPanel({
  overlaps,
  now,
  refUrls,
}: {
  overlaps: FileOverlap[];
  now: number;
  refUrls: Record<string, string>;
}): JSX.Element {
  if (overlaps.length === 0) {
    return <p className="empty">No two agents have written the same file at the same time.</p>;
  }
  return (
    <div className="overlaps">
      {overlaps.map((o) => (
        <div key={o.path} className={`overlap-card${o.live ? ' live' : ''}`}>
          <div className="overlap-head">
            <span className="mono overlap-path">{o.path}</span>
            {o.sameWorktree ? (
              <span
                className="chip small bad"
                title="Both agents shared a branch, so they shared one worktree — the same file on disk, edited by two live processes. There is no merge to reconcile this."
              >
                same worktree
              </span>
            ) : (
              <span
                className="chip small warn"
                title="Separate worktrees; the conflict surfaces at merge, if the hunks collide"
              >
                {o.writers.length} agents
              </span>
            )}
            {o.live && <span className="chip small">in flight</span>}
          </div>
          <ul className="overlap-writers">
            {o.writers.map((w) => (
              <li key={w.agentId}>
                {statusDot(w.status)}
                <span className="mono">{w.branch ?? 'no branch'}</span>
                <span className="muted">
                  {' — '}
                  {w.originRef ? refLink(w.originRef, refUrls) : (w.originTitle ?? 'untracked task')}
                  {', wrote it '}
                  {relTime(w.at, now)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
