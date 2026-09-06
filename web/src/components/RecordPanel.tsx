import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { WorkNodeView } from '../types.js';
import { Ref, RefLinksExtended } from './refs.js';
import { WorkRow } from './workTree.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

export function RecordPanel({ now }: { now: number }) {
  const [roots, setRoots] = useState<WorkNodeView[]>([]);
  const [rootUrls, setRootUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [showGoals, setShowGoals] = useState(false);
  const [subtree, setSubtree] = useState<{ nodes: WorkNodeView[]; refUrls: Record<string, string> } | null>(null);

  useEffect(() => {
    void api.getWorkRoots().then((r) => {
      setRoots(r.roots);
      setRootUrls(r.refUrls);
    });
  }, []);

  useEffect(() => {
    if (open === null) return;
    setSubtree(null);
    let live = true;
    void api.getWorkSubtree(open).then((r) => {
      if (live) setSubtree(r);
    });
    return () => {
      live = false;
    };
  }, [open]);

  if (roots.length === 0) {
    return <p className="empty">Nothing recorded yet — the graph fills in from the next pulse.</p>;
  }
  const goals = roots.filter((r) => r.ref.startsWith('issue:'));
  const loose = roots.filter((r) => !r.ref.startsWith('issue:'));
  return (
    <div className="work-roots">
      {goals.length > 0 && (
        <div className="work-goals">
          {/* Collapsed, not dropped. A goal's record is on its goal page now, but
              `Ref` is the only thing that knows whether this ref *has* one — a
              ticket the snapshot has forgotten has no page, and hiding its root
              here would make its record unreachable rather than relocated. So the
              rows stay, drawn as references, and the component picks the
              destination. */}
          <Button
            ghost
            className="work-goals-head"
            onClick={() => setShowGoals(!showGoals)}
            title="Each of these is drawn in full on its own goal page"
          >
            <span className="work-caret">{showGoals ? '▾' : '▸'}</span>
            {goals.length} {goals.length === 1 ? 'goal' : 'goals'} — each on its own page
          </Button>
          {showGoals && (
            <RefLinksExtended refUrls={rootUrls}>
              {goals.map((root) => (
                <div className="work-goal-row" key={root.ref}>
                  <span className="work-title">{root.title}</span>
                  <Tag tone={root.terminal ? 'green' : undefined}>{root.status}</Tag>
                  <span className="cn-refs">
                    <Ref to={root.ref} />
                  </span>
                </div>
              ))}
            </RefLinksExtended>
          )}
        </div>
      )}
      {loose.map((root) => (
        <div className="work-root" key={root.ref}>
          <Button ghost className="work-root-head" onClick={() => setOpen(open === root.ref ? null : root.ref)}>
            <span className="work-caret">{open === root.ref ? '▾' : '▸'}</span>
            <span className="work-title">{root.title}</span>
            <Tag tone={root.terminal ? 'green' : undefined}>{root.status}</Tag>
            {/* Plain, not a link: the whole header is a toggle `<button>`, and an
                `<a>` nested in one is invalid interactive content. The expanded
                subtree draws this same root node with its ref linked. */}
            <span className="muted mono">{root.ref}</span>
          </Button>
          {open === root.ref &&
            (subtree === null ? (
              <p className="muted work-loading">Reading the record…</p>
            ) : (
              <div className="work-tree">
                <RefLinksExtended refUrls={subtree.refUrls}>
                  {subtree.nodes.map((node) => (
                    <WorkRow key={node.ref} node={node} nodes={subtree.nodes} now={now} />
                  ))}
                </RefLinksExtended>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
