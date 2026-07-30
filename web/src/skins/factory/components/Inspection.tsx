import type { JSX } from 'react';
import type { PullRequest } from '../../../types.js';
import { refLink } from '../../../components/util.js';
import { ladderFor, loadedCount, prCourt, rack, rackReason } from '../inspection.js';
import { clip } from '../vocabulary.js';
import type { Scanner } from '../scanners.js';
import type { MergeGate } from '../inspection.js';

/**
 * Parts Inspection: every open pull request as one row.
 *
 * Two groups, and the split is `attention.status` — your court first, everything
 * else below and dimmed. Neither group collapses: a fold would put a second click
 * between an operator and *is anything stuck*, and one glance is the whole claim
 * this panel makes.
 */

/**
 * The ladder. Scanners on the left in a track of fixed width, the three human gates
 * on the right at a fixed x.
 *
 * The left group's cells **share** their track — three checks give three fat cells
 * and nine give nine thin ones — so a repository with a big CI matrix does not push
 * the gates out of column, and the strip stays readable downward. That is why the
 * scanners are a flex row inside a grid cell rather than grid columns of their own.
 *
 * Every cell's title is its own sentence, so the shape is scannable and the detail
 * is one hover away. The names come off the verdict; none is written here.
 */
function Ladder({ scanners, gates }: { scanners: Scanner[]; gates: MergeGate[] }): JSX.Element {
  const met = gates.filter((g) => g.met).length;
  const green = scanners.filter((s) => s.state === 'pass').length;
  return (
    <span
      className="fx-lad"
      role="img"
      aria-label={`${green} of ${scanners.length} checks passing, ${met} of ${gates.length} merge gates met`}
    >
      <span className="fx-lad-scan">
        {scanners.map((s) => (
          <i key={s.name} className={s.state} title={`${s.name} — ${s.status.word}`} />
        ))}
      </span>
      <i className="fx-lad-div" />
      {gates.map((g) => (
        <i key={g.label} className={g.met ? 'pass' : 'unmet'} title={`${g.label} — ${g.met ? 'met' : 'not met'}`} />
      ))}
    </span>
  );
}

function Row({ pr, refUrls, inHand }: { pr: PullRequest; refUrls: Record<string, string>; inHand: boolean }) {
  const court = prCourt(pr);
  const ladder = ladderFor(pr);
  const reason = rackReason(pr);
  // The stripe is the row's own severity, and it is the only red on the row besides
  // the chip: the ladder's states are amber, blue, green or unlit, which is what
  // keeps red meaning "a question only you can answer" on a row with four red
  // checks on it.
  const tone = inHand ? '' : court.tone === 'bad' ? ' you' : ' stalled';
  return (
    <div className={`fx-part${inHand ? ' hand' : ''}${tone}`}>
      <span className="fx-part-stripe" />
      <Ladder scanners={ladder.scanners} gates={ladder.gates} />
      <span className="fx-ref">{refLink(`#${pr.number}`, refUrls)}</span>
      <p className="fx-job" title={pr.title}>
        {clip(pr.title, 60)}
      </p>
      <span className="fx-part-why" title={reason}>
        {reason}
      </span>
      <span className={`fx-court ${court.tone}`}>{court.label}</span>
    </div>
  );
}

export function Inspection({
  prs,
  closed,
  refUrls,
}: {
  prs: PullRequest[];
  closed: PullRequest[];
  refUrls: Record<string, string>;
}): JSX.Element {
  const { yours, inHand } = rack(prs);
  const loaded = loadedCount(closed);

  return (
    <div className="fx-rack">
      {/* Empty still draws. A surface that vanishes when quiet is indistinguishable
          from one that broke — the rule the fault gauge is kept muted-but-present for. */}
      {prs.length === 0 && <p className="fx-empty">Nothing on the rack — no open pull requests.</p>}

      {yours.length > 0 && (
        <>
          <p className="fx-sub">Your court · {yours.length}</p>
          <div className="fx-parts">
            {yours.map((pr) => (
              <Row key={pr.id} pr={pr} refUrls={refUrls} inHand={false} />
            ))}
          </div>
        </>
      )}

      {inHand.length > 0 && (
        <>
          <p className="fx-sub">In hand · {inHand.length}</p>
          <div className="fx-parts">
            {inHand.map((pr) => (
              <Row key={pr.id} pr={pr} refUrls={refUrls} inHand />
            ))}
          </div>
        </>
      )}

      {prs.length > 0 && (
        <p className="fx-lad-key">
          <span>
            <i className="pass" /> passing
          </span>
          <span>
            <i className="damaged" /> failing · a bot is coming
          </span>
          <span>
            <i className="not_ours" /> failing · policy holds it
          </span>
          <span>
            <i className="muted" /> muted by policy
          </span>
          <span>
            <i className="awaiting" /> not reported yet
          </span>
          <span className="fx-lad-key-tail">checks · then approved · comments · conflicts</span>
        </p>
      )}
      {loaded > 0 && (
        <p className="fx-empty">
          {loaded} part{loaded === 1 ? '' : 's'} loaded into the silo in the retained window.
        </p>
      )}
    </div>
  );
}
