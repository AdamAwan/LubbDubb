import { useEffect, useState } from 'react';
import type { ScratchEntryView } from '../types.js';
import { api } from '../api.js';
import { relTime } from './util.js';
import { Modal } from './Modal.js';
import { Tag } from './tag.js';

/**
 * A goal's shared scratchpad — what the agents working it left each other, in the
 * order they wrote it.
 *
 * Until now this was readable only by an agent (`scratch_read`) and quotable only
 * by the retrospective that was handed it. That made the retrospective the sole
 * account of a run whose evidence nobody outside the fleet could check, and an
 * operator watching a goal go wrong had no way to read the reasoning as it was
 * written. This is the trail itself, unedited: it is append-only in the store, so
 * what is drawn here is exactly what was written, including the entries a later
 * agent contradicted.
 *
 * Fetched on open rather than read off `/api/state`, for `RetroModal`'s reason
 * with more force — a pad is unbounded prose from every agent on the goal,
 * where a write-up is one document. The snapshot carries the count and the age,
 * which is all the control that opens this needs to draw itself.
 *
 * Three states, and the third is the point again: loading, the trail, and **an
 * error** — a fetch that failed must not render as "nobody wrote anything". That
 * matters more here than for the write-up, because an empty pad is unreachable by
 * construction: nothing draws a way in unless the snapshot says there are entries,
 * so an empty trail on screen means the fetch and the snapshot disagree.
 *
 * A **fork** — an entry carrying a `decision` — is drawn apart from a note: what
 * was chosen, why, and the alternatives rejected with their reasons. The rejected
 * list is the part a diff can never show, so it is the part given the room.
 * → docs/spec/31-review-packs.md#the-witness-log
 */
export function ScratchpadModal({ issueRef, onClose }: { issueRef: string; onClose: () => void }) {
  const [entries, setEntries] = useState<ScratchEntryView[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let live = true;
    setState('loading');
    api
      .getScratchpad(issueRef)
      .then((res) => {
        if (!live) return;
        setEntries(res.entries);
        setState('ready');
      })
      .catch(() => {
        if (live) setState('failed');
      });
    return () => {
      live = false;
    };
  }, [issueRef]);

  const issueNumber = /^issue:(\d+)/.exec(issueRef)?.[1] ?? null;

  return (
    <Modal
      face="modal"
      title="Notepad"
      lead={issueNumber && <Tag>#{issueNumber}</Tag>}
      chips={
        state === 'ready' &&
        entries.length > 0 && (
          <Tag>
            {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
          </Tag>
        )
      }
      onClose={onClose}
    >
      <div className="pm-note-line">
        What the agents on this goal wrote each other, oldest first. Nothing here is edited or removed.
      </div>
      {state === 'loading' && <p className="empty">Loading…</p>}
      {state === 'failed' && <p className="empty">Could not load the notepad.</p>}
      {state === 'ready' && entries.length === 0 && <p className="empty">Nothing has been written on this pad.</p>}
      {state === 'ready' && entries.length > 0 && (
        <div className="pm-doc">
          {entries.map((entry) => (
            <div key={entry.id} className="pad-entry">
              <div className="pad-entry-head">
                {/* The author's origin, not its agent id: which *part* of the
                      goal wrote this is what a reader is placing the note by, and
                      an agent id is gone the moment the fleet turns over. */}
                <Tag>{entry.authorOriginRef}</Tag>
                {entry.decision && <Tag tone="blue">fork</Tag>}
                {entry.topic && <Tag>{entry.topic}</Tag>}
                <span className="muted" title={entry.createdAt}>
                  {relTime(entry.createdAt)}
                </span>
              </div>
              {/* Plain text, deliberately: a pad note keeps its newlines because
                    it is prose a human reads, and rendering it as markdown would
                    let an agent's stray backtick or hash change what its own
                    testimony looks like. */}
              <div className="pad-entry-note">{entry.note}</div>
              {entry.decision && (
                <div className="pad-decision">
                  <div className="pad-decision-row">
                    <span className="pad-decision-label">Chose</span>
                    <span>{entry.decision.chose}</span>
                  </div>
                  <div className="pad-decision-row">
                    <span className="pad-decision-label">Because</span>
                    <span>{entry.decision.because}</span>
                  </div>
                  {entry.decision.rejected.length > 0 && (
                    <div className="pad-decision-row">
                      <span className="pad-decision-label">Rejected</span>
                      <ul className="pad-decision-rejected">
                        {entry.decision.rejected.map((r, i) => (
                          <li key={i}>
                            <span>{r.alternative}</span>
                            <span className="muted"> — {r.because}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {entry.decision.paths.length > 0 && (
                    <div className="pad-decision-row">
                      <span className="pad-decision-label">Paths</span>
                      <span className="pad-decision-paths">{entry.decision.paths.join(', ')}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
