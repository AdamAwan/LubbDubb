import { useEffect, useState } from 'react';
import type { RetrospectiveView } from '../types.js';
import { api } from '../api.js';
import { renderMarkdown } from './markdown.js';

/**
 * A goal's retrospective, on demand — what shipped, and how the run went.
 *
 * Fetched on open rather than read off `/api/state`, for the reason the work graph
 * is: that snapshot is polled continuously, and a write-up per issue would be paid
 * for on every poll by every open cockpit. The station that opens this already has
 * the summary, which is all it needs to draw itself.
 *
 * Three states, and the third is the point: loading, the document, and **an error**
 * — because a fetch that failed must not render as "nobody wrote this up". Silence
 * is a real answer here (the Manifest station draws it), so it cannot also be the
 * failure mode.
 */
export function RetroModal({ issueRef, onClose }: { issueRef: string; onClose: () => void }) {
  const [retro, setRetro] = useState<RetrospectiveView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');

  useEffect(() => {
    let live = true;
    setState('loading');
    api
      .getRetrospective(issueRef)
      .then((res) => {
        if (!live) return;
        setRetro(res.retrospective);
        setState('ready');
      })
      .catch(() => {
        if (live) setState('failed');
      });
    return () => {
      live = false;
    };
  }, [issueRef]);

  const issueNumber = /^issue:(\d+)$/.exec(issueRef)?.[1] ?? null;

  return (
    <div className="plan-modal-backdrop" onClick={onClose}>
      <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pm-head">
          {issueNumber && <span className="chip small">#{issueNumber}</span>}
          <span className="pm-title">Retrospective</span>
          <button className="btn ghost small pm-close" onClick={onClose}>
            close
          </button>
        </div>
        {state === 'loading' && <p className="empty">Loading…</p>}
        {state === 'failed' && <p className="empty">Could not load the retrospective.</p>}
        {state === 'ready' && !retro && <p className="empty">Nothing was written up for this goal.</p>}
        {state === 'ready' && retro && (
          <>
            <div className="pm-note-line">{retro.summary}</div>
            <div className="pm-doc">{renderMarkdown(retro.document)}</div>
          </>
        )}
      </div>
    </div>
  );
}
