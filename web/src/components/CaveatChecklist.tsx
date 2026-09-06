import { useMemo, useState } from 'react';
import type { PlanCaveat } from '../types.js';
import { renderMarkdown } from './markdown.js';

// → docs/spec/17-cockpit.md

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

export function useAcknowledgements(caveats: PlanCaveat[]): {
  ticked: ReadonlySet<string>;
  toggle: (id: string) => void;
  acknowledged: string[];
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

export function heldTitle(outstanding: PlanCaveat[]): string {
  return outstanding.length === 1
    ? 'One box left to tick before this plan can be released'
    : `${outstanding.length} boxes left to tick before this plan can be released`;
}
