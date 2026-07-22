import type { JSX, ReactNode } from 'react';

/** An external link that opens safely in a new tab. */
function ExtLink({ href, children }: { href: string; children: ReactNode }): JSX.Element {
  return (
    <a className="ext-ref" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Render one reference token (e.g. `#42`, `issue/13`) as a link when the provider
 * gave us a URL for it, else as plain text. URLs come from the server-built
 * `refUrls` map — the cockpit never constructs them.
 */
export function refLink(token: string, refUrls: Record<string, string>): ReactNode {
  const url = refUrls[token];
  return url ? <ExtLink href={url}>{token}</ExtLink> : token;
}

// Issue/PR mentions in free text — the universal `#<number>` GitHub syntax.
const REF_TOKEN = /#\d+/g;

/**
 * Turn every recognised external reference in a run of text into a clickable
 * link, leaving the rest as-is. Used for labels, decision reasons and escalation
 * prompts, which embed refs like "PR #42" as plain strings.
 */
export function linkify(text: string, refUrls: Record<string, string>): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(REF_TOKEN)) {
    const at = m.index;
    if (at > last) out.push(text.slice(last, at));
    out.push(<span key={key++}>{refLink(m[0], refUrls)}</span>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A coloured status dot for CI / agent status. */
export function statusDot(status: string): JSX.Element {
  const cls =
    status === 'passing' || status === 'done'
      ? 'green'
      : status === 'failing' || status === 'failed'
        ? 'red'
        : status === 'waiting'
          ? 'amber'
          : status === 'running' || status === 'starting'
            ? 'blue'
            : 'grey';
  return <span className={`dot ${cls}`} title={status} />;
}

export function relTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

/** Compact elapsed duration between two instants, e.g. "3m 12s" or "0:07". */
export function elapsed(fromIso: string, toIso: string | null, now: number = Date.now()): string {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : now;
  const secs = Math.max(0, Math.round((to - from) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
