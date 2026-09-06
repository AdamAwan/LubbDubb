import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { UnrecordedWorkView } from '../types.js';
import { refLink, relTime } from './util.js';
import { AsyncButton } from './AsyncButton.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

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
  }, []);

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
            ghost
            onClick={() => api.setWorkItemIgnored(item.ref, false).then(() => load())}
            title="Put this back in the list"
          >
            Un-ignore
          </AsyncButton>
        ) : (
          <>
            {item.filing !== null ? (
              <Tag>filing…</Tag>
            ) : (
              canFileTickets && (
                <AsyncButton
                  ghost
                  onClick={() => api.fileWorkItem(item.ref).then(() => load())}
                  title="Ask an agent to create a tracker item recording this work"
                >
                  File a work item
                </AsyncButton>
              )
            )}
            <AsyncButton
              ghost
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
          <Button ghost className="work-ignored-head" onClick={() => setShowIgnored(!showIgnored)}>
            <span className="work-caret">{showIgnored ? '▾' : '▸'}</span>
            {ignored.length} ignored
          </Button>
          {showIgnored && ignored.map(row)}
        </div>
      )}
    </section>
  );
}
