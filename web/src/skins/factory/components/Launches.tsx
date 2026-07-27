import type { JSX } from 'react';
import type { PullRequest } from '../../../types.js';
import { refLink, relTime } from '../../../components/util.js';
import { Icon } from './Sprite.js';

/**
 * The silo. A launch is a merge to the default branch — the one event on this
 * floor that means work actually left it.
 *
 * The rocket fires only when there is something to fire for: the list comes from
 * `closedPullRequests`, the window the server actually retains, so an empty
 * window draws a silo standing idle rather than a celebration on a loop. A
 * scrapped launch (closed unmerged) is listed in grey beside the merges,
 * because a PR that was abandoned is exactly the thing the old cockpit lost.
 */
export function Launches({
  closed,
  now,
  refUrls,
}: {
  closed: PullRequest[];
  now: number;
  refUrls: Record<string, string>;
}): JSX.Element {
  const merged = closed.filter((pr) => pr.state === 'merged' || pr.merged);
  const fired = merged.length > 0;

  return (
    <div className="fx-launches">
      <div className="fx-silo fx-sunk">
        <svg
          viewBox="0 0 90 132"
          role="img"
          aria-label={`Rocket silo; ${merged.length} launched in the retained window`}
        >
          {fired && (
            <g className="fx-exhaust" style={{ transformOrigin: '45px 96px' }}>
              <path d="M38 92 L45 128 L52 92 Z" fill="var(--accent)" opacity=".55" />
              <path d="M41 92 L45 116 L49 92 Z" fill="var(--fx-belt)" opacity=".8" />
            </g>
          )}
          <g className={fired ? 'fx-rocket' : undefined} style={{ color: fired ? 'var(--muted)' : 'var(--grey)' }}>
            <svg x="27" y="34" width="36" height="60" viewBox="0 0 24 24">
              <use href="#fx-i-rocket" />
            </svg>
          </g>
          <path d="M14 96 h62 v30 h-62 z" fill="var(--panel)" stroke="var(--border-hi)" strokeWidth="1.5" />
          <path d="M14 96 h62" stroke="var(--border-lo)" strokeWidth="2" />
          <g stroke="var(--border-lo)" strokeWidth="1">
            <rect x="20" y="103" width="12" height="16" fill="var(--panel-2)" />
            <rect
              x="39"
              y="103"
              width="12"
              height="16"
              fill={fired ? 'var(--accent)' : 'var(--panel-2)'}
              opacity=".7"
            />
            <rect x="58" y="103" width="12" height="16" fill="var(--panel-2)" />
          </g>
        </svg>
        <p className="fx-silo-cap">{merged.length} launched</p>
      </div>

      <div className="fx-launch-list">
        {closed.length === 0 && <p className="fx-empty">Nothing has left the pad in the retained window.</p>}
        {closed.map((pr) => {
          const landed = pr.state === 'merged' || pr.merged;
          return (
            <div key={pr.id} className={`fx-launch ${landed ? '' : 'scrapped'}`}>
              <Icon name={landed ? 'rocket' : 'chest'} className="sm" title={landed ? 'merged' : 'closed unmerged'} />
              <span className="fx-ref">{refLink(`#${pr.number}`, refUrls)}</span>
              <span className="t" title={pr.title}>
                {pr.title}
              </span>
              <span className="fx-ref">{pr.closedAt ? relTime(pr.closedAt, now) : ''}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
