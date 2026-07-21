import { useMemo, useState } from 'react';
import type { Decision } from '../types.js';
import { relTime } from './util.js';

/**
 * The audit trail. Every decision the harness made, newest first, each with its
 * outcome, the action it chose, the reason the dispatcher gave, and when. The
 * filter chips let you narrow to just what executed, or just what got deferred.
 */
export function DecisionLog({ decisions, now }: { decisions: Decision[]; now: number }) {
  const [filter, setFilter] = useState<string>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: decisions.length };
    for (const d of decisions) c[d.outcome] = (c[d.outcome] ?? 0) + 1;
    return c;
  }, [decisions]);

  const outcomes = ['all', 'executed', 'deferred', 'skipped', 'rejected'].filter((o) => o === 'all' || counts[o]);
  const shown = filter === 'all' ? decisions : decisions.filter((d) => d.outcome === filter);

  return (
    <>
      <div className="log-filters">
        {outcomes.map((o) => (
          <button key={o} className={`filter-chip ${o} ${filter === o ? 'active' : ''}`} onClick={() => setFilter(o)}>
            {o} <span className="filter-count">{counts[o] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="auditlog">
        {shown.length === 0 && <p className="empty">No decisions match.</p>}
        {shown.map((d) => (
          <div key={d.id} className={`audit ${d.outcome}`}>
            <div className="audit-top">
              <span className={`badge ${d.outcome}`}>{d.outcome}</span>
              <span className="audit-type">{d.action.type}</span>
              <span className="muted audit-time">{relTime(d.createdAt, now)}</span>
            </div>
            {d.action.reason && <div className="audit-reason">“{d.action.reason}”</div>}
            {d.detail && <div className="audit-detail">{d.detail}</div>}
          </div>
        ))}
      </div>
    </>
  );
}
