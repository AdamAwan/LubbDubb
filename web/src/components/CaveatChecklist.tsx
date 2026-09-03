import { useMemo, useState } from 'react';
import type { PlanCaveat } from '../types.js';
import { renderMarkdown } from './markdown.js';

/**
 * The things a plan raises, drawn as boxes the operator ticks — and the state that
 * holds the Approve button until they have.
 *
 * ## Why a box and not a paragraph
 *
 * Approving a plan starts every agent, branch and pull request it declares, and
 * what the operator was told first was prose: the planner's own uncertainty, a part
 * that is already blocked, a pull request open on the issue that belongs to no part
 * of the plan. A paragraph above a primary button is the most skippable thing on a
 * card, and nothing anywhere recorded whether it had been read — the careful
 * approval and the blind one wrote identical rows.
 *
 * A tick is not proof of reading, and it is not meant to be. What it does is make
 * the skip *deliberate*: the caveat has to be met, one box at a time, on the way to
 * the button. The server refuses the accept while any of them is unticked
 * (`src/plans/planCaveats.ts`), so this is the shape of a precondition rather than
 * a courtesy the glass could decide to skip.
 *
 * ## What it deliberately does not gate
 *
 * Only Approve. Reject, Hold and Close the ticket are all ways of *not* releasing
 * the work, and holding an operator on a reading list before they may say no would
 * put the friction on the safe verdict. Nothing here disables those.
 */
export function CaveatChecklist({
  caveats,
  ticked,
  onToggle,
  refUrls,
}: {
  caveats: PlanCaveat[];
  ticked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  refUrls: Record<string, string>;
}) {
  if (caveats.length === 0) return null;
  return (
    <div className="caveat-ack">
      <div className="muted small caveat-ack-label">
        Tick to approve
        <span className="caveat-ack-count">
          {ticked.size}/{caveats.length}
        </span>
      </div>
      {caveats.map((c) => (
        <label key={c.id} className={`caveat-ack-item${ticked.has(c.id) ? ' done' : ''}`}>
          <input type="checkbox" checked={ticked.has(c.id)} onChange={() => onToggle(c.id)} />
          <span className="caveat-ack-body">
            <span className="caveat-ack-text">{c.label}</span>
            {/* What the label is about — the planner's own words, or the stored
                reason. Drawn, not folded behind a disclosure: a box you tick without
                the thing it is about being on the page is the paragraph again. The
                label carries the weight and this is quiet, so a list of several is
                scanned by its titles and read by the one that matters. */}
            {c.detail ? <span className="caveat-ack-detail">{renderMarkdown(c.detail, refUrls)}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}

/**
 * The ticks, and what is still outstanding.
 *
 * Keyed on the caveat ids so a proposal that is replaced under an open card — a
 * replan, an amendment — drops ticks that no longer name anything: `outstanding` is
 * computed from the current list, never from a count that was right a moment ago.
 * Local state rather than the cockpit's `Place` because it is not "where am I": it
 * is one unsent verdict, and it is gone with the card either way.
 */
export function useAcknowledgements(caveats: PlanCaveat[]): {
  ticked: ReadonlySet<string>;
  toggle: (id: string) => void;
  /** The caveat ids to send with the accept. */
  acknowledged: string[];
  /** What is still unticked — non-empty means Approve is held. */
  outstanding: PlanCaveat[];
} {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const outstanding = useMemo(() => caveats.filter((c) => !ticked.has(c.id)), [caveats, ticked]);
  const acknowledged = useMemo(() => caveats.filter((c) => ticked.has(c.id)).map((c) => c.id), [caveats, ticked]);
  return {
    ticked,
    toggle: (id) =>
      setTicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    acknowledged,
    outstanding,
  };
}

/** What the held button says it is waiting for — one sentence, both surfaces. */
export function heldTitle(outstanding: PlanCaveat[]): string {
  return outstanding.length === 1
    ? 'One box left to tick before this plan can be released'
    : `${outstanding.length} boxes left to tick before this plan can be released`;
}
