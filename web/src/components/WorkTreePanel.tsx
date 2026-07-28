import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { UnrecordedWorkView, WorkNodeView } from '../types.js';
import { refLink, relTime } from './util.js';
import { AsyncButton } from './AsyncButton.js';

/**
 * The durable record of what the harness did for a work item — the one surface
 * that outlives the world. Every other panel draws the snapshot, so each of them
 * forgets a PR the moment it ages out of `closedPrWindowMs`; this one still knows
 * that PR #40 merged, and which issue it delivered.
 *
 * **Fetched on open, never polled.** The graph rides its own routes rather than
 * `/api/state` because that endpoint comes round every couple of seconds and the
 * graph only ever grows — the roots are read once, a subtree when one is expanded.
 * That is the whole reason `/api/work` and `/api/work/:ref` are two routes.
 *
 * It is a lens: nothing here (and nothing in the dispatcher) decides anything from
 * what it draws.
 */
export function WorkTreePanel({ now, canFileTickets }: { now: number; canFileTickets: boolean }) {
  const [roots, setRoots] = useState<WorkNodeView[]>([]);
  const [unrecorded, setUnrecorded] = useState<UnrecordedWorkView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [subtree, setSubtree] = useState<{ nodes: WorkNodeView[]; refUrls: Record<string, string> } | null>(null);

  const load = () =>
    api.getWorkRoots().then((r) => {
      setRoots(r.roots);
      setUnrecorded(r.unrecorded);
    });

  useEffect(() => {
    void load();
    // Read once on mount, like the roots — the panel is fetched, never polled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (open === null) return;
    // Cleared first, so an expanded root never shows the previous one's tree
    // while its own is in flight.
    setSubtree(null);
    let live = true;
    void api.getWorkSubtree(open).then((r) => {
      if (live) setSubtree(r);
    });
    return () => {
      live = false;
    };
  }, [open]);

  if (roots.length === 0 && unrecorded.length === 0) {
    return <p className="empty">Nothing recorded yet — the graph fills in from the next pulse.</p>;
  }
  return (
    <div className="work-roots">
      {unrecorded.length > 0 && (
        <div className="work-unrecorded">
          <h3>Unrecorded work</h3>
          <p className="muted">
            The harness did this, and nothing in the tracker accounts for it — so nobody outside can ever mark it done.
          </p>
          {unrecorded.map((item) => (
            <div className="work-unrecorded-row" key={item.ref}>
              <span className="work-title">{item.title}</span>
              <span className="muted mono">{item.ref}</span>
              <span className="muted">
                {item.prCount === 1 ? '1 pull request' : `${item.prCount} pull requests`} · started{' '}
                {relTime(item.firstSeenAt, now)}
              </span>
              {item.filing !== null ? (
                <span className="chip small">filing…</span>
              ) : (
                canFileTickets && (
                  <AsyncButton
                    className="ghost"
                    onClick={() => api.fileWorkItem(item.ref).then(() => load())}
                    title="Ask an agent to create a tracker item recording this work"
                  >
                    File a work item
                  </AsyncButton>
                )
              )}
            </div>
          ))}
        </div>
      )}
      {roots.map((root) => (
        <div className="work-root" key={root.ref}>
          <button
            type="button"
            className="ghost work-root-head"
            onClick={() => setOpen(open === root.ref ? null : root.ref)}
          >
            <span className="work-caret">{open === root.ref ? '▾' : '▸'}</span>
            <span className="work-title">{root.title}</span>
            <span className={`chip small${root.terminal ? ' ok' : ''}`}>{root.status}</span>
            <span className="muted mono">{root.ref}</span>
          </button>
          {open === root.ref &&
            (subtree === null ? (
              <p className="muted work-loading">Reading the record…</p>
            ) : (
              <div className="work-tree">
                {subtree.nodes.map((node) => (
                  <WorkRow key={node.ref} node={node} nodes={subtree.nodes} refUrls={subtree.refUrls} now={now} />
                ))}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function WorkRow({
  node,
  nodes,
  refUrls,
  now,
}: {
  node: WorkNodeView;
  nodes: WorkNodeView[];
  refUrls: Record<string, string>;
  now: number;
}) {
  return (
    <div className={`work-node ${node.kind}`} style={{ marginLeft: `${depth(node, nodes) * 14}px` }}>
      <span className="work-mark">{MARK[node.kind] ?? '·'}</span>
      <span className="work-title">{node.title}</span>
      <span className={`chip small${node.terminal ? ' ok' : ''}`}>{node.status}</span>
      {/* Absence-means-merged is a deliberate fallback everywhere in the harness,
          but a durable record has no business forgetting it *was* one. */}
      {node.provenance === 'inferred' && (
        <span className="chip small warn" title="No merge was ever observed — this PR simply left the world">
          inferred
        </span>
      )}
      {node.baseRef !== null && (
        <span className="chip small" title="Stacked on this PR — a cross-link, not what caused the work">
          on {node.baseRef}
        </span>
      )}
      <span className="muted mono">{refLink(node.ref, refUrls)}</span>
      <span className="muted work-seen" title={`First seen ${node.firstSeenAt}`}>
        {relTime(node.lastSeenAt, now)}
      </span>
    </div>
  );
}

/**
 * How deep a node sits, by walking `parentRef` within the subtree — so the indent
 * needs no ordering contract from the server, and a node whose parent is outside
 * the fetched subtree simply sits at the top rather than disappearing.
 */
function depth(node: WorkNodeView, nodes: WorkNodeView[]): number {
  let d = 0;
  let cur = node.parentRef;
  while (cur !== null && d < nodes.length) {
    const parent = nodes.find((n) => n.ref === cur);
    if (!parent) break;
    d += 1;
    cur = parent.parentRef;
  }
  return d;
}

/** What each kind is, at a glance. */
const MARK: Record<string, string> = {
  issue: '◆',
  plan: '⌗',
  part: '▪',
  pr: '⇡',
  concern: '!',
  job: '▸',
  assess: '?',
};
