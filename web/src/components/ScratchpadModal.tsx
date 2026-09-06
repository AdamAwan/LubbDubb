import { useEffect, useState } from 'react';
import type { ScratchEntryView } from '../types.js';
import { api } from '../api.js';
import { relTime } from './util.js';
import { Modal } from './Modal.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

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
