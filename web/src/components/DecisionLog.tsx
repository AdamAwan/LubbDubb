import { useMemo, useState } from 'react';
import type { Decision, DispatchRule, Proposal } from '../types.js';
import { relTime, linkify } from './util.js';

/**
 * The audit trail. Every decision the harness made, newest first, each with its
 * outcome, the action it chose, the reason the dispatcher gave, and when. The
 * filter chips let you narrow to just what executed, or just what got deferred.
 * Clicking a row expands it to show the dispatcher rule that produced it.
 *
 * Rows the *human* authorized are marked as such: the table records what the
 * harness decided each cycle and had no idea what you decided, which was the
 * missing half of the trail (issue #109). A row carrying no proposal is the
 * harness acting on its own — the common case, and deliberately unlabelled.
 */
export function DecisionLog({
  decisions,
  proposals,
  now,
  refUrls,
  rules,
}: {
  decisions: Decision[];
  /** Acts a human settled; a decision names its proposal through its cycle id. */
  proposals?: Proposal[];
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

  // A human-authorized act is recorded under the cycle id `human:<proposal id>`,
  // the way lifecycle bookkeeping uses `agent-lifecycle` — so the link back to who
  // decided (and what they said about it) needs no column on the decisions table.
  const byId = new Map((proposals ?? []).map((p) => [p.id, p]));
  const deciderOf = (d: Decision): Proposal | undefined =>
    d.cycleId.startsWith('human:') ? byId.get(d.cycleId.slice('human:'.length)) : undefined;

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
          const decider = deciderOf(d);
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
                {decider && (
                  <span className="chip small" title={decider.note ?? 'Authorized by you'}>
                    you · {decider.status}
                  </span>
                )}
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
