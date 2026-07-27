import type { JSX } from 'react';
import type { PullRequest } from '../../../types.js';
import { refLink } from '../../../components/util.js';
import { siloCourt, siloFill, siloGates } from '../silo.js';
import { clip, toneColor } from '../vocabulary.js';

/**
 * Open PRs, drawn as silos filling toward a launch.
 *
 * The Launches panel beside this is a *log* — it lists what already left the
 * pad. That is the half with no tension in it: by the time a PR appears there,
 * nothing about it can be acted on. A silo three gates of four full is the same
 * data one step earlier, when it is still a thing you can do something about.
 *
 * The fill is a fixed four-gate denominator (see `siloGates`); `health.reasons`
 * is quoted underneath as the server's own account of what is wrong, never
 * parsed for the count.
 */

const BODY_TOP = 52;
const BODY_H = 112;

function Silo({ pr, refUrls }: { pr: PullRequest; refUrls: Record<string, string> }): JSX.Element {
  const gates = siloGates(pr);
  const fill = siloFill(gates);
  const court = siloCourt(pr);
  const ready = fill === 1;
  const color = ready ? 'var(--green)' : toneColor(court.tone);
  const fillH = Math.round(BODY_H * fill);
  const met = gates.filter((g) => g.met).length;

  return (
    <article className="fx-silo-card fx-sunk">
      <svg
        className="fx-silo-tower"
        viewBox="0 0 86 184"
        role="img"
        aria-label={`PR ${pr.number}: ${met} of ${gates.length} merge gates met`}
      >
        <path d="M43 4 L70 52 H16 Z" fill="var(--panel)" stroke="var(--border-hi)" strokeWidth="1.5" />
        <rect
          x="16"
          y={BODY_TOP}
          width="54"
          height={BODY_H}
          fill="var(--well)"
          stroke="var(--border-hi)"
          strokeWidth="1.5"
        />
        {fillH > 0 && (
          <>
            <rect x="18" y={BODY_TOP + BODY_H - fillH} width="50" height={fillH} fill={color} opacity=".24" />
            <path d={`M18 ${BODY_TOP + BODY_H - fillH} h50`} stroke={color} strokeWidth="1.6" />
          </>
        )}
        <g stroke="var(--border-lo)" strokeWidth="1" opacity=".5">
          <path d="M16 79h54M16 106h54M16 133h54" />
        </g>
        <g style={{ color }} className={ready ? 'fx-silo-ready' : undefined} opacity={ready ? 1 : 0.5}>
          <svg x="29" y={ready ? 84 : 116} width="28" height="28" viewBox="0 0 24 24">
            <use href={ready ? '#fx-i-rocket' : '#fx-i-gear'} />
          </svg>
        </g>
        <rect x="10" y="164" width="66" height="14" fill="var(--panel)" stroke="var(--border-hi)" strokeWidth="1.4" />
        <text className="fx-mono" x="43" y="174" textAnchor="middle" fill={color}>
          {met} / {gates.length}
        </text>
      </svg>

      <div className="fx-silo-meta">
        <span className="fx-ref">{refLink(`#${pr.number}`, refUrls)}</span>
        <p className="fx-job" title={pr.title}>
          {clip(pr.title, 46)}
        </p>
        <ul className="fx-gates">
          {gates.map((gate) => (
            <li key={gate.label} className={gate.met ? 'ok' : 'no'}>
              <span className="tick">{gate.met ? '✓' : '✕'}</span>
              {gate.label}
            </li>
          ))}
        </ul>
        <span className={`fx-court ${court.tone}`}>{ready ? 'Launch ready' : court.label}</span>
        {(pr.health?.reasons.length ?? 0) > 0 && <p className="fx-empty">{pr.health?.reasons.join(' · ')}</p>}
      </div>
    </article>
  );
}

export function Silos({ prs, refUrls }: { prs: PullRequest[]; refUrls: Record<string, string> }): JSX.Element {
  if (prs.length === 0) {
    return <p className="fx-empty">No open pull requests — nothing is on the pad.</p>;
  }
  // Fullest first: the one closest to launching is the one worth looking at.
  const ordered = prs.slice().sort((a, b) => siloFill(siloGates(b)) - siloFill(siloGates(a)) || a.number - b.number);
  return (
    <div className="fx-silos">
      {ordered.map((pr) => (
        <Silo key={pr.id} pr={pr} refUrls={refUrls} />
      ))}
    </div>
  );
}
