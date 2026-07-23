import type { DispatchRule, QueueItem, UpcomingPlan } from '../types.js';
import { refLink, relTime } from './util.js';

/**
 * The "Up next" queue (issue #69): the dispatcher's ordered pickup plan from the
 * last pulse, with the headroom cut-line drawn between what is dispatching now
 * and what waits for a free agent slot. A projection, not a committed queue —
 * the ranking is recomputed from the world every cycle, so it's labelled with
 * the pulse it came from.
 */
export function UpNext({
  plan,
  now,
  refUrls,
  rules,
}: {
  plan: UpcomingPlan | null;
  now: number;
  refUrls: Record<string, string>;
  /** The rule book, to label each queued item with the rule that ranked it. */
  rules: Record<string, DispatchRule>;
}) {
  if (!plan) {
    return <p className="empty">No pickup plan yet — it appears once a pulse has run (rule dispatcher only).</p>;
  }
  if (plan.items.length === 0) {
    return (
      <div className="upnext">
        <div className="upnext-asof">as of the pulse {relTime(plan.at, now)}</div>
        <p className="empty">Queue empty — nothing eligible to pick up.</p>
      </div>
    );
  }
  // The cut sits before the first below-cut ("waiting") item; cooldown items
  // keep their rank position but render greyed (throttled, not capacity-bound).
  const cutAt = plan.items.findIndex((q) => q.status === 'waiting');
  return (
    <div className="upnext">
      <div className="upnext-asof" title="Recomputed from the world every cycle — not a committed queue">
        as of the pulse {relTime(plan.at, now)}
      </div>
      {plan.items.map((q, idx) => (
        <div key={q.origin}>
          {idx === cutAt && (
            <div className="upnext-cut" title="Everything below waits for a free agent slot">
              <span>waiting for a slot</span>
            </div>
          )}
          <QueueRow item={q} refUrls={refUrls} rules={rules} />
        </div>
      ))}
    </div>
  );
}

function QueueRow({
  item,
  refUrls,
  rules,
}: {
  item: QueueItem;
  refUrls: Record<string, string>;
  rules: Record<string, DispatchRule>;
}) {
  const rule = rules[item.rule];
  return (
    <div className={`upnext-item ${item.status}`} title={item.reason}>
      <span className={`chip small${item.status === 'dispatching' ? ' ok' : ''}`}>
        {item.status === 'dispatching' ? '▶ now' : item.status}
      </span>
      {rule && (
        <span className="chip small" title={`Rule ${rule.number}: ${rule.name} — ${rule.description}`}>
          {rule.number}
        </span>
      )}
      <span className="upnext-title">{withOriginLink(item, refUrls)}</span>
      {item.kind === 'desk' && <span className="chip small">desk</span>}
    </div>
  );
}

/**
 * Link the item's `#N` where possible: origins are `pr:N:...` / `issue:N`, and
 * the title embeds the same number, so swap it for a refLink when the map has
 * one. URL construction stays server-side (`refUrls`), per the linkify rule.
 */
function withOriginLink(item: QueueItem, refUrls: Record<string, string>) {
  const m = /^(?:pr|issue):(\d+)/.exec(item.origin);
  if (!m) return item.title;
  const token = `#${m[1]}`;
  const at = item.title.indexOf(token);
  if (at === -1) return item.title;
  return (
    <>
      {item.title.slice(0, at)}
      {refLink(token, refUrls)}
      {item.title.slice(at + token.length)}
    </>
  );
}
