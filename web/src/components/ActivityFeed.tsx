import { useMemo, useState } from 'react';
import type { WorldEvent, WorldEventKind } from '../types.js';
import { relTime } from './util.js';

/**
 * The world's change history — the counterpart to the decision log, but for the
 * outside world rather than the harness. Each entry is one observed state
 * transition (a PR going green, a story moving to in_progress, …), newest first.
 * Category chips narrow to PRs / Issues / Stories / Meetings.
 */
export function ActivityFeed({ events, now }: { events: WorldEvent[]; now: number }) {
  const [filter, setFilter] = useState<string>('all');

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: events.length };
    for (const e of events) {
      const cat = categoryOf(e.kind);
      c[cat] = (c[cat] ?? 0) + 1;
    }
    return c;
  }, [events]);

  const categories = ['all', 'prs', 'issues', 'stories', 'meetings'].filter((c) => c === 'all' || counts[c]);
  const shown = filter === 'all' ? events : events.filter((e) => categoryOf(e.kind) === filter);

  return (
    <>
      <div className="log-filters">
        {categories.map((c) => (
          <button key={c} className={`filter-chip ${c} ${filter === c ? 'active' : ''}`} onClick={() => setFilter(c)}>
            {c} <span className="filter-count">{counts[c] ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="auditlog">
        {shown.length === 0 && <p className="empty">No activity yet — the world hasn&apos;t changed.</p>}
        {shown.map((e) => (
          <div key={e.id} className={`audit activity ${categoryOf(e.kind)}`}>
            <div className="audit-top">
              <span className={`badge ${categoryOf(e.kind)}`}>{labelOf(e.kind)}</span>
              <span className="muted audit-time">{relTime(e.createdAt, now)}</span>
            </div>
            <div className="audit-reason">{e.summary}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function categoryOf(kind: WorldEventKind): 'prs' | 'issues' | 'stories' | 'meetings' {
  if (kind.startsWith('pr_')) return 'prs';
  if (kind.startsWith('issue_')) return 'issues';
  if (kind.startsWith('story_')) return 'stories';
  return 'meetings';
}

/** Short human label for a transition kind (the badge text). */
function labelOf(kind: WorldEventKind): string {
  const labels: Record<WorldEventKind, string> = {
    pr_opened: 'PR opened',
    pr_ci: 'CI',
    pr_approved: 'approved',
    pr_mergeable: 'mergeable',
    pr_merged: 'merged',
    pr_comment: 'comment',
    issue_opened: 'issue opened',
    issue_closed: 'issue closed',
    issue_linked: 'linked',
    story_added: 'story added',
    story_state: 'story',
    meeting_added: 'meeting',
    meeting_prep: 'prep done',
  };
  return labels[kind];
}
