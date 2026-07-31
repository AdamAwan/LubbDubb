import { useEffect, useState } from 'react';
import type { ScratchEntryView } from '../types.js';
import { api } from '../api.js';
import { relTime } from './util.js';

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
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          {issueNumber && <span className="chip small">#{issueNumber}</span>}
          <span className="pm-title">Notepad</span>
          {state === 'ready' && entries.length > 0 && (
            <span className="chip small">
              {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
            </span>
          )}
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>
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
                  <span className="chip small">{entry.authorOriginRef}</span>
                  {entry.topic && <span className="chip small">{entry.topic}</span>}
                  <span className="muted" title={entry.createdAt}>
                    {relTime(entry.createdAt)}
                  </span>
                </div>
                {/* Plain text, deliberately: a pad note keeps its newlines because
                    it is prose a human reads, and rendering it as markdown would
                    let an agent's stray backtick or hash change what its own
                    testimony looks like. */}
                <div className="pad-entry-note">{entry.note}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
