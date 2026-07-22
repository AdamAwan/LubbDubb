import { useMemo, useState } from 'react';
import type { Decision, DispatchRule } from '../types.js';
import { relTime, linkify } from './util.js';

/**
 * The audit trail. Every decision the harness made, newest first, each with its
 * outcome, the action it chose, the reason the dispatcher gave, and when. The
 * filter chips let you narrow to just what executed, or just what got deferred.
 * Clicking a row expands it to show the dispatcher rule that produced it.
 */
export function DecisionLog({
  decisions,
  now,
  refUrls,
  rules,
}: {
  decisions: Decision[];
  now: number;
  refUrls: Record<string, string>;
  /** The rule dispatcher's rule book, keyed by the rule id a decision carries. */
  rules: Record<string, DispatchRule>;
}) {
  const [filter, setFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

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
        {shown.map((d) => {
          const rule = d.rule ? rules[d.rule] : undefined;
          const expanded = expandedId === d.id;
          return (
            <div
              key={d.id}
              className={`audit clickable ${d.outcome}`}
              role="button"
              tabIndex={0}
              title={expanded ? 'Hide dispatch rule' : 'Show dispatch rule'}
              onClick={() => setExpandedId(expanded ? null : d.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setExpandedId(expanded ? null : d.id);
                }
              }}
            >
              <div className="audit-top">
                <span className={`badge ${d.outcome}`}>{d.outcome}</span>
                <span className="audit-type">{d.action.type}</span>
                <span className="muted audit-time">{relTime(d.createdAt, now)}</span>
                <span className={`audit-chevron ${expanded ? 'open' : ''}`}>▸</span>
              </div>
              {d.action.reason && <div className="audit-reason">“{linkify(d.action.reason, refUrls)}”</div>}
              {d.detail && <div className="audit-detail">{linkify(d.detail, refUrls)}</div>}
              {expanded && (
                <div className="audit-rule">
                  {rule ? (
                    <>
                      <div className="audit-rule-head">
                        <span className="audit-rule-number">Rule {rule.number}</span>
                        <span className="audit-rule-name">{rule.name}</span>
                      </div>
                      <div className="audit-rule-desc">{rule.description}</div>
                    </>
                  ) : (
                    <div className="audit-rule-desc muted">
                      No dispatcher rule recorded for this decision
                      {d.rule ? ` (unknown rule id "${d.rule}")` : ''}.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
