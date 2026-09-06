import { useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { WorkNodeView } from '../types.js';
import { RefLinksExtended } from './refs.js';
import { WorkRow } from './workTree.js';

// → docs/spec/17-cockpit.md

export function WorkRecord({
  goalRef,
  now,
  open,
  onToggle,
}: {
  goalRef: string;
  now: number;
  open: boolean;
  onToggle: (open: boolean) => void;
}): JSX.Element {
  const [record, setRecord] = useState<{ nodes: WorkNodeView[]; refUrls: Record<string, string> } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setRecord(null);
    setMissing(false);
    if (!open) return;
    let live = true;
    void api
      .getWorkSubtree(goalRef)
      .then((r) => {
        if (live) setRecord(r);
      })
      .catch(() => {
        if (live) setMissing(true);
      });
    return () => {
      live = false;
    };
  }, [goalRef, open]);

  const nodes = record?.nodes.filter((n) => n.ref !== goalRef) ?? [];
  return (
    <>
      <h3>
        <button type="button" className="cn-disc" aria-expanded={open} onClick={() => onToggle(!open)}>
          <i className="cn-caret">{open ? '▾' : '▸'}</i>
          The record
        </button>
        {nodes.length > 0 && <i className="cn-n">{nodes.length}</i>}
        <span className="cn-more">what happened, after the world forgot</span>
      </h3>
      {open && (
        <div className="work-record">
          {missing && <p className="cn-empty">Nothing is recorded for this goal — the graph fills in from a pulse.</p>}
          {!missing && record === null && <p className="cn-empty">Reading the record…</p>}
          {record !== null && nodes.length === 0 && (
            <p className="cn-empty">The goal is on the record, and nothing has happened under it yet.</p>
          )}
          {record !== null && nodes.length > 0 && (
            <RefLinksExtended refUrls={record.refUrls}>
              {nodes.map((node) => (
                <WorkRow key={node.ref} node={node} nodes={nodes} now={now} />
              ))}
            </RefLinksExtended>
          )}
        </div>
      )}
    </>
  );
}
