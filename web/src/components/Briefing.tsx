import type { ReactNode } from 'react';
import type { DeskBriefing, BriefingMeeting, BriefingMail, BriefingPing } from '../types.js';

/** A briefing older than this reads as stale — the bridge hasn't refreshed recently. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * The read-only desk panel: what's on the operator's Microsoft 365 desk — meetings,
 * mail and Teams pings — as gathered by the Claude bridge. Unlike the harness world,
 * nothing here is acted on; it's a passive at-a-glance surface. Each item links out
 * to its source (Teams join / Outlook web link). A "stale" badge warns when the
 * briefing is more than three hours old.
 */
export function Briefing({ briefing, now = Date.now() }: { briefing: DeskBriefing | null; now?: number }) {
  if (!briefing) {
    return (
      <div className="briefing empty-panel calm">
        <span className="empty-mark">✉</span>
        <p>No desk briefing yet. The Claude bridge hasn&apos;t posted one.</p>
      </div>
    );
  }

  const stale = now - new Date(briefing.generatedAt).getTime() > STALE_AFTER_MS;
  const asOf = new Date(briefing.generatedAt).toLocaleString();

  return (
    <div className="briefing">
      <div className="briefing-head">
        <span className="briefing-asof">as of {asOf}</span>
        {stale && (
          <span className="chip small warn" title="This briefing is more than 3 hours old">
            stale
          </span>
        )}
      </div>

      <BriefingSection title="Meetings" count={briefing.meetings.length}>
        {briefing.meetings.map((m) => (
          <MeetingRow key={m.id} m={m} />
        ))}
      </BriefingSection>

      <BriefingSection title="Mail" count={briefing.mail.length}>
        {briefing.mail.map((m) => (
          <MailRow key={m.id} m={m} />
        ))}
      </BriefingSection>

      <BriefingSection title="Pings" count={briefing.pings.length}>
        {briefing.pings.map((p) => (
          <PingRow key={p.id} p={p} />
        ))}
      </BriefingSection>
    </div>
  );
}

function BriefingSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="briefing-section">
      <div className="world-row">
        <span>{title}</span>
        <b>{count}</b>
      </div>
      {count === 0 && <p className="empty">Nothing here.</p>}
      {children}
    </div>
  );
}

/** Wrap an item's label in an outbound link when it has a target, else render plain. */
function Out({ href, children }: { href?: string; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function MeetingRow({ m }: { m: BriefingMeeting }) {
  const at = new Date(m.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="briefing-item">
      <span className="briefing-when">{at}</span>
      <Out href={m.joinUrl ?? m.webLink}>{m.subject || '(untitled event)'}</Out>
      {m.isOnline && <span className="chip small">online</span>}
      {m.responseRequested && <span className="chip small warn">reply</span>}
      {m.relevance === 'area' && <span className="chip small">area</span>}
    </div>
  );
}

function MailRow({ m }: { m: BriefingMail }) {
  return (
    <div className="briefing-item">
      <Out href={m.webLink}>{m.subject || '(no subject)'}</Out>
      <span className="briefing-from">{m.from}</span>
      {m.isUnread && <span className="chip small warn">unread</span>}
      {m.isFlagged && <span className="chip small warn">flagged</span>}
      {m.preview && <span className="briefing-preview">{m.preview}</span>}
    </div>
  );
}

function PingRow({ p }: { p: BriefingPing }) {
  return (
    <div className="briefing-item">
      <Out href={p.webLink}>{p.chatOrChannel}</Out>
      <span className="briefing-from">{p.from}</span>
      {p.preview && <span className="briefing-preview">{p.preview}</span>}
    </div>
  );
}
