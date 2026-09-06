import { useEffect, useState } from 'react';
import type { RetrospectiveView } from '../types.js';
import { api } from '../api.js';
import { renderMarkdown } from './markdown.js';
import { Modal } from './Modal.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

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
    <Modal face="modal" title="Retrospective" lead={issueNumber && <Tag>#{issueNumber}</Tag>} onClose={onClose}>
      {state === 'loading' && <p className="empty">Loading…</p>}
      {state === 'failed' && <p className="empty">Could not load the retrospective.</p>}
      {state === 'ready' && !retro && <p className="empty">Nothing was written up for this goal.</p>}
      {state === 'ready' && retro && (
        <>
          <div className="pm-note-line">{retro.summary}</div>
          <div className="pm-doc">{renderMarkdown(retro.document)}</div>
        </>
      )}
    </Modal>
  );
}
