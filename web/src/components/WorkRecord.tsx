import { useEffect, useState, type JSX } from 'react';
import { api } from '../api.js';
import type { WorkNodeView } from '../types.js';
import { RefLinksExtended } from './refs.js';
import { WorkRow } from './workTree.js';

/**
 * What actually happened on one goal — the goal's own subtree of the durable work
 * graph, drawn on its page.
 *
 * ## Why the goal page needs it
 *
 * Every other card on that page reads the world snapshot, and the snapshot forgets:
 * `closedPullRequests` remembers a merge for `closedPrWindowMs` and then drops it.
 * So a goal that shipped three pull requests three weeks ago draws
 * "No pull request names this goal yet" — on a page about work that demonstrably
 * happened. The record is the one surface that outlives that, and it was reachable
 * only from a tab nobody opens, which is the same fact stated twice.
 *
 * It carries what nothing else on the page keeps, either: the `inferred` chip on a
 * merge the harness never watched, concerns raised and cleared, and — since jobs
 * are adopted by the origin they stand in for — the requeues, sitting under the
 * part they redid rather than floating as orphans.
 *
 * ## The root is dropped
 *
 * `GET /api/work/:ref` returns the root with its subtree, and the root here is the
 * page you are standing on. Drawing `◆ #35174 Re-measure event-path coverage` at
 * the top of that goal's own page is a row that answers a question nobody asked;
 * `depth`'s orphan arm then lands its children flush left on their own.
 *
 * ## Fetched on open, never polled
 *
 * The tab's discipline, for the tab's reason: `/api/state` comes round every couple
 * of seconds and the graph only ever grows. Being a card on a page opened
 * deliberately is what keeps "on open" honest — nothing fetches until an operator
 * goes to a goal. Since the goal page folds it away, "open" is now the disclosure
 * rather than the page, and the fetch waits for it: a card nobody has unfolded
 * costs no request at all.
 *
 * ## The disclosure is its own heading's
 *
 * `open` and `onToggle` are the component's rather than its caller's because the
 * count is: the heading says how many nodes there are, and only this knows. A
 * caller drawing its own heading over a folded record would be a second heading
 * with no count in it, or one that lied when the record grew.
 *
 * It is a **lens**. Nothing here, and nothing in the dispatcher, decides anything
 * from what it draws.
 */
export function WorkRecord({
  goalRef,
  now,
  open,
  onToggle,
}: {
  goalRef: string;
  now: number;
  open: boolean;
  /** The state being *set*, never a bare toggle — the caret already says which way. */
  onToggle: (open: boolean) => void;
}): JSX.Element {
  const [record, setRecord] = useState<{ nodes: WorkNodeView[]; refUrls: Record<string, string> } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    // Cleared first, so opening a second goal never shows the previous one's
    // record while its own is in flight — the tab's own rule for the same reason.
    setRecord(null);
    setMissing(false);
    if (!open) return;
    let live = true;
    void api
      .getWorkSubtree(goalRef)
      .then((r) => {
        if (live) setRecord(r);
      })
      // A goal the fold has never observed 404s, which is not a fault: it is a
      // ticket picked up minutes ago, or one the harness never worked. Recording
      // it through `errors` would file an error report for the ordinary case.
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
