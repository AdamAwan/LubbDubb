import { useMemo, useState } from 'react';
import type { CaveatAnswerInput, PlanCaveat } from '../types.js';
import { renderMarkdown } from './markdown.js';

// → docs/spec/17-cockpit.md

export function CaveatChecklist({
  caveats,
  ticked,
  answers,
  onToggle,
  onAnswer,
  refUrls,
}: {
  caveats: PlanCaveat[];
  ticked: ReadonlySet<string>;
  answers: Readonly<Record<string, string>>;
  onToggle: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
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
        <div key={c.id} className={`caveat-ack-item${ticked.has(c.id) ? ' done' : ''}`}>
          <label className="caveat-ack-tick">
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
          {/* Outside the label, or a click meant for the field would tick the box.
              Half of what a plan raises is a question or a choice between two things
              the planner named, and the only answer the card had was the one that
              sends the whole plan back to a planner. */}
          <input
            className="caveat-ack-answer"
            placeholder="Optional — answer it, or ask your question"
            title="Goes on the plan for whoever works it. It does not send the plan back for a replan."
            value={answers[c.id] ?? ''}
            onChange={(e) => onAnswer(c.id, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

export function useAcknowledgements(caveats: PlanCaveat[]): {
  ticked: ReadonlySet<string>;
  toggle: (id: string) => void;
  written: Readonly<Record<string, string>>;
  answer: (id: string, text: string) => void;
  answers: CaveatAnswerInput[];
  acknowledged: string[];
  outstanding: PlanCaveat[];
} {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const [written, setWritten] = useState<Readonly<Record<string, string>>>({});
  const outstanding = useMemo(() => caveats.filter((c) => !ticked.has(c.id)), [caveats, ticked]);
  const acknowledged = useMemo(() => caveats.filter((c) => ticked.has(c.id)).map((c) => c.id), [caveats, ticked]);
  // Every caveat that carries words, ticked or not: the accept is gated on the ticks
  // alone, and an answer typed against a box is the operator's either way.
  const answers = useMemo(
    () =>
      caveats.flatMap((c) => {
        const words = (written[c.id] ?? '').trim();
        return words === '' ? [] : [{ id: c.id, answer: words }];
      }),
    [caveats, written],
  );
  return {
    ticked,
    toggle: (id) =>
      setTicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    written,
    answer: (id, text) => setWritten((prev) => ({ ...prev, [id]: text })),
    answers,
    acknowledged,
    outstanding,
  };
}

export function heldTitle(outstanding: PlanCaveat[]): string {
  return outstanding.length === 1
    ? 'One box left to tick before this plan can be released'
    : `${outstanding.length} boxes left to tick before this plan can be released`;
}
