import type { ErrorLogEntry } from '../types.js';
import { relTime } from './util.js';

/**
 * The error log — recorded failures (cycle exceptions, provider outages, agent
 * crashes, route 500s), newest first. The counterpart to the decision log for
 * things going wrong: each entry carries its source, message, and (when captured)
 * a collapsible detail (stack trace / output tail).
 */
export function ErrorsPanel({ errors, now }: { errors: ErrorLogEntry[]; now: number }) {
  return (
    <div className="auditlog">
      {errors.length === 0 && <p className="empty">No errors recorded — everything is running clean.</p>}
      {errors.map((e) => (
        <div key={e.id} className="audit error-entry">
          <div className="audit-top">
            <span className="badge failed">{e.source}</span>
            <span className="muted audit-time">{relTime(e.createdAt, now)}</span>
          </div>
          <div className="audit-reason">{e.message}</div>
          {e.detail && (
            <details className="error-detail">
              <summary>detail</summary>
              <pre>{e.detail}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
