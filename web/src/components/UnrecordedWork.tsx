import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { UnrecordedWorkView } from '../types.js';
import { refLink, relTime } from './util.js';
import { AsyncButton } from './AsyncButton.js';

/**
 * What the harness did that nothing in the tracker accounts for — and the two
 * verdicts an operator casts on it.
 *
 * It is drawn at the head of the **tickets** tab, which is the surface triage
 * happens on, because that is what this list is: `File a work item` and `Ignore`
 * are a triage decision on a row nobody outside can otherwise ever mark done. It
 * used to sit at the head of the Work tab, where it was the only part of that tab
 * still doing anything — the record itself moved onto the goal pages, so what was
 * left was this list behind a nav slot of its own.
 *
 * **Fetched on open and never polled**, on `/api/work` alongside the roots the
 * record panel reads — the graph rides its own route rather than `/api/state`
 * because that endpoint comes round every couple of seconds and this list changes
 * on the pulse at most. → `docs/spec/17-cockpit.md#unrecorded-work`
 *
 * It draws **nothing at all when there is nothing outstanding**, which is the one
 * place it differs from the cards on the overview: those are gauges an operator
 * glances at the same spot for, and this is a call-out above somebody else's list.
 * A permanent "nothing to record" heading over the tickets table would be a row of
 * chrome saying so on every visit.
 */
export function UnrecordedWork({ now, canFileTickets }: { now: number; canFileTickets: boolean }) {
  const [items, setItems] = useState<UnrecordedWorkView[]>([]);
  const [refUrls, setRefUrls] = useState<Record<string, string>>({});
  const [showIgnored, setShowIgnored] = useState(false);

  const load = () =>
    api.getWorkRoots().then((r) => {
      setItems(r.unrecorded);
      setRefUrls(r.refUrls);
    });

  useEffect(() => {
    void load();
    // Read once on mount — fetched, never polled.
  }, []);

  // Split here rather than at the source: the server carries `ignored` so this and
  // the file route read one verdict, and keeping the row means its title is still
  // there to offer back under the tail.
  const live = items.filter((u) => !u.ignored);
  const ignored = items.filter((u) => u.ignored);
  if (items.length === 0) return null;

  const row = (item: UnrecordedWorkView) => (
    <div className="work-unrecorded-row" key={item.ref}>
      <span className="work-title">{item.title}</span>
      <span className="muted mono">{refLink(item.ref, refUrls)}</span>
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
    <section className="work-unrecorded">
      <h3>Unrecorded work</h3>
      <p className="muted">
        The harness did this, and nothing in the tracker accounts for it — so nobody outside can ever mark it done.
      </p>
      {live.map(row)}
      {live.length === 0 && <p className="muted">Nothing outstanding — every item here has been dealt with.</p>}
      {ignored.length > 0 && (
        <div className="work-ignored">
          <button type="button" className="btn ghost work-ignored-head" onClick={() => setShowIgnored(!showIgnored)}>
            <span className="work-caret">{showIgnored ? '▾' : '▸'}</span>
            {ignored.length} ignored
          </button>
          {showIgnored && ignored.map(row)}
        </div>
      )}
    </section>
  );
}
