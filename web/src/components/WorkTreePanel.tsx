import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { UnrecordedWorkView, WorkNodeView } from '../types.js';
import { refLink, relTime } from './util.js';
import { AsyncButton } from './AsyncButton.js';
import { Ref, RefLinksExtended } from './refs.js';
import { WorkRow } from './workTree.js';

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
  const [rootUrls, setRootUrls] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [showGoals, setShowGoals] = useState(false);
  const [subtree, setSubtree] = useState<{ nodes: WorkNodeView[]; refUrls: Record<string, string> } | null>(null);

  const load = () =>
    api.getWorkRoots().then((r) => {
      setRoots(r.roots);
      setUnrecorded(r.unrecorded);
      setRootUrls(r.refUrls);
    });

  useEffect(() => {
    void load();
    // Read once on mount, like the roots — the panel is fetched, never polled.
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
  // Split here rather than at the source: the server carries `ignored` so the panel
  // and the file route read one verdict, and keeping the row means its title is
  // still there to offer back under the tail.
  const live = unrecorded.filter((u) => !u.ignored);
  const ignored = unrecorded.filter((u) => u.ignored);
  // A goal root is the one kind of record with somewhere better to be: its whole
  // subtree is drawn on its goal page. What is left here is what has no page —
  // operator jobs, and the work items filed for them — which is what this tab is
  // for now that the history reads where the reader already is.
  const goals = roots.filter((r) => r.ref.startsWith('issue:'));
  const loose = roots.filter((r) => !r.ref.startsWith('issue:'));
  const row = (item: UnrecordedWorkView) => (
    <div className="work-unrecorded-row" key={item.ref}>
      <span className="work-title">{item.title}</span>
      <span className="muted mono">{refLink(item.ref, rootUrls)}</span>
      <span className="muted work-seen">
        {item.prCount === 1 ? '1 pull request' : `${item.prCount} pull requests`} · started{' '}
        {relTime(item.firstSeenAt, now)}
      </span>
      <span className="work-unrecorded-actions">
        {item.ignored ? (
          <AsyncButton
            className="ghost"
            onClick={() => api.setWorkItemIgnored(item.ref, false).then(() => load())}
            title="Put this back in the list"
          >
            Un-ignore
          </AsyncButton>
        ) : (
          <>
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
            <AsyncButton
              className="ghost"
              onClick={() => api.setWorkItemIgnored(item.ref, true).then(() => load())}
              title="No tracker item is wanted for this — clear it from the list"
            >
              Ignore
            </AsyncButton>
          </>
        )}
      </span>
    </div>
  );
  return (
    <div className="work-roots">
      {unrecorded.length > 0 && (
        <div className="work-unrecorded">
          <h3>Unrecorded work</h3>
          <p className="muted">
            The harness did this, and nothing in the tracker accounts for it — so nobody outside can ever mark it done.
          </p>
          {live.map(row)}
          {live.length === 0 && <p className="muted">Nothing outstanding — every item here has been dealt with.</p>}
          {ignored.length > 0 && (
            <div className="work-ignored">
              <button
                type="button"
                className="btn ghost work-ignored-head"
                onClick={() => setShowIgnored(!showIgnored)}
              >
                <span className="work-caret">{showIgnored ? '▾' : '▸'}</span>
                {ignored.length} ignored
              </button>
              {showIgnored && ignored.map(row)}
            </div>
          )}
        </div>
      )}
      {goals.length > 0 && (
        <div className="work-goals">
          {/* Collapsed, not dropped. A goal's record is on its goal page now, but
              `Ref` is the only thing that knows whether this ref *has* one — a
              ticket the snapshot has forgotten has no page, and hiding its root
              here would make its record unreachable rather than relocated. So the
              rows stay, drawn as references, and the component picks the
              destination. */}
          <button
            type="button"
            className="btn ghost work-goals-head"
            onClick={() => setShowGoals(!showGoals)}
            title="Each of these is drawn in full on its own goal page"
          >
            <span className="work-caret">{showGoals ? '▾' : '▸'}</span>
            {goals.length} {goals.length === 1 ? 'goal' : 'goals'} — each on its own page
          </button>
          {showGoals && (
            <RefLinksExtended refUrls={rootUrls}>
              {goals.map((root) => (
                <div className="work-goal-row" key={root.ref}>
                  <span className="work-title">{root.title}</span>
                  <span className={`chip small${root.terminal ? ' ok' : ''}`}>{root.status}</span>
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
          <button
            type="button"
            className="btn ghost work-root-head"
            onClick={() => setOpen(open === root.ref ? null : root.ref)}
          >
            <span className="work-caret">{open === root.ref ? '▾' : '▸'}</span>
            <span className="work-title">{root.title}</span>
            <span className={`chip small${root.terminal ? ' ok' : ''}`}>{root.status}</span>
            {/* Plain, not a link: the whole header is a toggle `<button>`, and an
                `<a>` nested in one is invalid interactive content. The expanded
                subtree draws this same root node with its ref linked. */}
            <span className="muted mono">{root.ref}</span>
          </button>
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
