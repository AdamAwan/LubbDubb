import type { JSX } from 'react';
import type {
  ReviewAttention,
  ReviewCalibration,
  ReviewOverridePair,
  ReviewOverrideReading,
  ReviewPlumbingPack,
  ReviewPlumbingReading,
  ReviewProminenceReading,
} from '../types.js';

/**
 * Review — what the review packs say about the agents that write them.
 *
 * Three readings, and they sit on one tab because they are three answers to one
 * question: **is this subsystem's own output drifting?** None of them is about a
 * particular pull request; each is a pattern over packs, and the action each
 * points at is the same one — a person changing a prompt, once, deliberately.
 *
 * **It is never shown to the checker.** A reviewer's override is recorded and
 * withheld from every later pack: given the overrides the checker would calibrate
 * to what reviewers like rather than to what is risky, and a label that has
 * learned to agree with its reader has stopped being evidence. Surfacing it here
 * is the whole of what is done with it.
 * → docs/spec/31-review-packs.md#the-operators-reading
 *
 * It lives on Insights rather than on Knowledge deliberately. Knowledge is what
 * the fleet is *told*, and a pack produces none — putting this there would draw a
 * feedback path the subsystem does not have. Insights is where an operator reads
 * whether the harness is working, which is exactly what these three are.
 */
export function ReviewCalibrationTab({ calibration }: { calibration: ReviewCalibration }): JSX.Element {
  if (calibration.packs === 0) {
    return (
      <p className="empty">
        No review pack was written in this window. Nothing here is a reading about a pull request — it is a reading
        about the agents that write the packs, so it needs packs.
      </p>
    );
  }
  return (
    <div className="rc">
      <p className="rc-lede">
        Over the <b>{calibration.packs}</b> {calibration.packs === 1 ? 'pack' : 'packs'} written in this window — one
        per pull request, the one the page draws. Nothing on this tab is ever shown to the checker.
      </p>
      <Overrides o={calibration.overrides} />
      <Plumbing p={calibration.plumbing} />
      <Prominence p={calibration.prominence} />
    </div>
  );
}

const LABEL: Record<ReviewAttention, string> = { read: 'Read', decide: 'Decide', skim: 'Skim', split: 'Split' };

/**
 * The overrides. The figure that matters is **upgrades**: reviewers steadily
 * moving `skim` to `read` says the checker is systematically underselling risk,
 * and that is a change to its prompt rather than to any one pack.
 */
function Overrides({ o }: { o: ReviewOverrideReading }): JSX.Element {
  return (
    <section className="rc-block">
      <h3>Where reviewers disagree with the checker</h3>
      <p className="rc-note">
        An idea counts as overridden only when every hunk it owns carries the same reviewer label — the same rule the
        pack page lays marks by.
      </p>
      <div className="rc-figures">
        <Figure value={o.labelled} label="ideas the checker labelled" />
        <Figure value={o.overridden} label="a reviewer relabelled" />
        <Figure value={o.upgrades} label="toward more scrutiny" strong={o.upgrades > o.downgrades} />
        <Figure value={o.downgrades} label="toward less" />
        <Figure value={o.sideways} label="onto or off split" />
      </div>
      {o.pairs.length === 0 ? (
        <p className="rc-none">Nobody has overridden a label in this window.</p>
      ) : (
        <table className="rc-table">
          <thead>
            <tr>
              <th>The checker said</th>
              <th>The reviewer said</th>
              <th className="num">Times</th>
            </tr>
          </thead>
          <tbody>
            {o.pairs.map((pair) => (
              <PairRow key={`${pair.from}>${pair.to}`} pair={pair} />
            ))}
          </tbody>
        </table>
      )}
      {o.upgrades > o.downgrades && o.upgrades > 0 && (
        <p className="rc-verdict">
          Reviewers are asking for <b>more</b> scrutiny than the checker does, more often than the reverse. If that
          holds over a few dozen ideas, the <code>review-pack-check</code> prompt is what to change — not any one pack,
          and never by showing the checker these numbers.
        </p>
      )}
    </section>
  );
}

/**
 * The plumbing ratio: how much of what the authors wrote they declined to
 * explain. `plumbing` is the honest answer for a rename or a lockfile, and it is
 * also where an author puts anything it cannot be bothered to explain — so the
 * ratio is the signal that it has started rotting.
 */
function Plumbing({ p }: { p: ReviewPlumbingReading }): JSX.Element {
  return (
    <section className="rc-block">
      <h3>How much the authors called plumbing</h3>
      <p className="rc-note">
        Every hunk in a diff has exactly one owning idea, and <code>plumbing</code> is the reserved one for hunks that
        carry nothing to review. A rising share of them is an author explaining less, not a repository with more renames
        in it.
      </p>
      <div className="rc-figures">
        <Figure value={p.hunks} label="hunks owned" />
        <Figure value={p.plumbingHunks} label="of them plumbing" />
        <Figure
          value={p.ratio === null ? '—' : `${Math.round(p.ratio * 100)}%`}
          label="the ratio"
          strong={p.ratio !== null && p.ratio >= 0.5}
        />
      </div>
      {p.worst.length === 0 ? (
        <p className="rc-none">No pack in this window claimed a hunk as plumbing.</p>
      ) : (
        <table className="rc-table">
          <thead>
            <tr>
              <th>Pull request</th>
              <th className="num">Plumbing</th>
              <th className="num">Hunks</th>
              <th className="num">Share</th>
            </tr>
          </thead>
          <tbody>
            {p.worst.map((row) => (
              <PlumbingRow key={`${row.prNumber}:${row.headSha}`} row={row} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Whether the loudest thing on the page gets read. The four surface requirements
 * a false claim makes are checkable as an order things are drawn in, and none of
 * them measures that — a pull request that merged with a false claim nobody
 * marked seen does.
 */
function Prominence({ p }: { p: ReviewProminenceReading }): JSX.Element {
  return (
    <section className="rc-block">
      <h3>Whether the false claims got read</h3>
      <p className="rc-note">
        Nothing about a false claim blocks a merge — that is deliberate, and the answer to the risk it creates is
        prominence rather than a lock. This is the one number that says whether prominence is working.
      </p>
      <div className="rc-figures">
        <Figure value={p.packsWithFalse} label="packs with a false claim" />
        <Figure value={p.falseClaims} label="false claims" />
        <Figure value={`${p.seen}/${p.ideas}`} label="findings taken" />
        <Figure value={p.mergedUnseen.length} label="merged unread" strong={p.mergedUnseen.length > 0} />
      </div>
      {p.mergedUnseen.length > 0 && (
        <p className="rc-verdict">
          {p.mergedUnseen.length === 1 ? 'One pull request' : `${p.mergedUnseen.length} pull requests`} merged with a
          false claim nobody marked as read: {p.mergedUnseen.map((n) => `#${n}`).join(', ')}. Either the finding was
          wrong and the pack needs re-asking, or the page is not loud enough.
        </p>
      )}
    </section>
  );
}

function PairRow({ pair }: { pair: ReviewOverridePair }): JSX.Element {
  return (
    <tr>
      <td>{LABEL[pair.from]}</td>
      <td>{LABEL[pair.to]}</td>
      <td className="num">{pair.count}</td>
    </tr>
  );
}

/** One pack's share, drawn as a number rather than a link: there is no pull request page to send anybody to. */
function PlumbingRow({ row }: { row: ReviewPlumbingPack }): JSX.Element {
  return (
    <tr>
      <td>#{row.prNumber}</td>
      <td className="num">{row.plumbingHunks}</td>
      <td className="num">{row.hunks}</td>
      <td className="num">{Math.round(row.ratio * 100)}%</td>
    </tr>
  );
}

function Figure({ value, label, strong }: { value: number | string; label: string; strong?: boolean }): JSX.Element {
  return (
    <div className={`rc-figure${strong === true ? ' is-loud' : ''}`}>
      <span className="rc-figure-v">{value}</span>
      <span className="rc-figure-l">{label}</span>
    </div>
  );
}
