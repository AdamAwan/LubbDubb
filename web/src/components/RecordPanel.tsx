import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { WorkNodeView } from '../types.js';
import { Ref, RefLinksExtended } from './refs.js';
import { WorkRow } from './workTree.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

/**
 * The durable record of what the harness did — the one surface that outlives the
 * world. Every other panel draws the snapshot, so each of them forgets a PR the
 * moment it ages out of `closedPrWindowMs`; this one still knows that PR #40
 * merged, and which issue it delivered.
 *
 * **A panel rather than a nav tab.** It was the console's second destination, and
 * by the end it was drawing almost nothing at full weight: a goal's own subtree
 * moved onto its goal page, where the reader already is, and the triage list that
 * was left at its head belongs with the other triage, on the tickets tab. What
 * remains is a record you consult — an archive, opened when a question sends you
 * to it — and the nav is for the surfaces work happens *on*. Kept rather than
 * dropped, because it is the only way to a root whose ticket the world has
 * forgotten: `Ref` is what knows whether a ref still has a goal page, and a
 * surface that assumed one would make those records unreachable rather than
 * relocated.
 *
 * **Fetched on open, never polled.** The graph rides its own routes rather than
 * `/api/state` because that endpoint comes round every couple of seconds and the
 * graph only ever grows — the roots are read once, a subtree when one is expanded.
 * That is the whole reason `/api/work` and `/api/work/:ref` are two routes, and a
 * panel is what makes "on open" honest: nothing fetches until it is opened.
 *
 * It is a lens: nothing here (and nothing in the dispatcher) decides anything from
 * what it draws. → `docs/spec/17-cockpit.md#the-record-panel`
 */
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
    // Read once on mount — the panel is fetched, never polled.
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

  if (roots.length === 0) {
    return <p className="empty">Nothing recorded yet — the graph fills in from the next pulse.</p>;
  }
  // A goal root is the one kind of record with somewhere better to be: its whole
  // subtree is drawn on its goal page. What is left at full weight is what has no
  // page — operator jobs, and the work items filed for them.
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
