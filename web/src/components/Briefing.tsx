import type { ReactNode } from 'react';
import type { DeskBriefing, BriefingMeeting, BriefingMail, BriefingPing } from '../types.js';

/** A briefing older than this reads as stale — the bridge hasn't refreshed recently. */
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * The read-only desk panel: what's on the operator's Microsoft 365 desk — meetings,
 * mail and Teams pings — as gathered by the Claude bridge. Unlike the harness world,
 * nothing here is acted on; it's a passive at-a-glance surface.
 *
 * Meetings are the spine: grouped by day (Today / Tomorrow / weekday) so the date is
 * never ambiguous, shown as start–end ranges, with past meetings dimmed and the next
 * one up highlighted below a live "now" line. Mail and pings follow as compact
 * sub-sections. Each item links out to its source (Teams join / Outlook web link). A
 * "stale" badge warns when the briefing is more than three hours old.
 *
 * (The harness world used to list these same meetings too; that duplicate is gone —
 * the calendar lives only here now.)
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
  const asOf = new Date(briefing.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

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

      <Agenda meetings={briefing.meetings} now={now} />

      <MailSection mail={briefing.mail} />
      <PingSection pings={briefing.pings} />
    </div>
  );
}

// ── Meetings agenda ──────────────────────────────────────────────────────────

/** Local calendar-day identity — meetings on the same date share a group. */
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today" / "Tomorrow" / "Yesterday" / weekday — relative to `now`, in local time. */
function dayLabel(date: Date, now: number): string {
  const diff = Math.round((startOfDay(date.getTime()) - startOfDay(now)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long' });
}

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const dayStamp = (d: Date) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/** Short "now / in 12m / in 3h" tag for the next meeting up. */
function untilLabel(startMs: number, endMs: number, now: number): string {
  if (now >= startMs && now < endMs) return 'now';
  const mins = Math.round((startMs - now) / 60_000);
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}

function Agenda({ meetings, now }: { meetings: BriefingMeeting[]; now: number }) {
  const sorted = [...meetings].sort((a, b) => +new Date(a.start) - +new Date(b.start));
  // The next meeting up: the earliest one that hasn't ended yet (may be in progress).
  const next = sorted.find((m) => +new Date(m.end) > now);
  const todayKey = dayKey(new Date(now));

  // Group by calendar day, preserving chronological order.
  const groups: { key: string; date: Date; items: BriefingMeeting[] }[] = [];
  for (const m of sorted) {
    const date = new Date(m.start);
    const key = dayKey(date);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, date, items: [] };
      groups.push(g);
    }
    g.items.push(m);
  }

  return (
    <div className="briefing-section">
      <div className="subsec-h">
        <span>Agenda</span>
        <span className="chip small count">{meetings.length}</span>
      </div>

      {meetings.length === 0 && <p className="empty">Nothing scheduled.</p>}

      {groups.map((g) => (
        <div key={g.key} className="agenda-day">
          <div className="day-head">
            <span className={`day-label${g.key === todayKey ? ' today' : ''}`}>{dayLabel(g.date, now)}</span>
            <span className="day-date">{dayStamp(g.date)}</span>
            <span className="day-more">{g.items.length === 1 ? '1 meeting' : `${g.items.length} meetings`}</span>
          </div>
          {g.items.map((m) => {
            const isNext = m.id === next?.id;
            // The "now" divider sits just above the next meeting, but only on today.
            const showNow = isNext && g.key === todayKey;
            return (
              <div key={m.id}>
                {showNow && (
                  <div className="nowline">
                    <span className="lbl">now {hhmm(new Date(now).toISOString())}</span>
                    <span className="rule" />
                  </div>
                )}
                <MeetingRow m={m} now={now} isNext={isNext} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function MeetingRow({ m, now, isNext }: { m: BriefingMeeting; now: number; isNext: boolean }) {
  const past = +new Date(m.end) <= now;
  const cls = `meet${isNext ? ' next' : ''}${past ? ' past' : ''}`;
  return (
    <div className={cls}>
      <div className="mtime">
        {hhmm(m.start)}
        <span className="mtime-end">{hhmm(m.end)}</span>
      </div>
      <div className="mbody">
        <div className="msubj">
          <Out href={m.joinUrl ?? m.webLink}>{m.subject || '(untitled event)'}</Out>
        </div>
        <div className="mchips">
          {isNext && !past && (
            <span className="chip small">{untilLabel(+new Date(m.start), +new Date(m.end), now)}</span>
          )}
          {m.isOnline && <span className="chip small ok">online</span>}
          {m.responseRequested && <span className="chip small warn">reply</span>}
          {m.relevance === 'area' && <span className="chip small">area</span>}
        </div>
      </div>
    </div>
  );
}

// ── Mail & pings ─────────────────────────────────────────────────────────────

function MailSection({ mail }: { mail: BriefingMail[] }) {
  const unread = mail.filter((m) => m.isUnread).length;
  return (
    <div className="briefing-section">
      <div className="subsec-h">
        <span className="dot blue" /> <span>Mail</span>
        <span className="chip small count">{unread > 0 ? `${unread} unread` : String(mail.length)}</span>
      </div>
      {mail.length === 0 && <p className="empty">Nothing here.</p>}
      {mail.map((m) => (
        <MailRow key={m.id} m={m} />
      ))}
    </div>
  );
}

function MailRow({ m }: { m: BriefingMail }) {
  return (
    <div className="mailrow">
      {m.isUnread && <span className="unread-dot" />}
      <Out href={m.webLink}>{m.subject || '(no subject)'}</Out>
      <span className="from">{m.from}</span>
      {m.isFlagged && <span className="chip small warn">flagged</span>}
    </div>
  );
}

function PingSection({ pings }: { pings: BriefingPing[] }) {
  return (
    <div className="briefing-section">
      <div className="subsec-h">
        <span className="dot green" /> <span>Pings</span>
        <span className="chip small count">{pings.length}</span>
      </div>
      {pings.length === 0 && <p className="empty">Nothing here.</p>}
      {pings.map((p) => (
        <PingRow key={p.id} p={p} />
      ))}
    </div>
  );
}

function PingRow({ p }: { p: BriefingPing }) {
  return (
    <div className="mailrow ping">
      <Out href={p.webLink}>{p.chatOrChannel}</Out>
      <span className="from">{p.from}</span>
      {p.preview && <span className="ping-preview">{p.preview}</span>}
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
