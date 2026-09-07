import type { JSX, ReactNode } from 'react';
import { buttonClass, type ButtonLook } from './button.js';
import { CONTROL_CLASS } from './controls.js';

// → docs/spec/17-cockpit.md

/**
 * An external link that opens safely in a new tab.
 *
 * `boxed` is the difference between the two shapes a reference takes: a token
 * standing on its own gets the box (`.ref-out`), a reference inside a sentence
 * gets the arrow alone. It defaults to unboxed because every caller here is prose
 * or a chip that already has a box of its own — only `<Ref>` draws the standalone
 * token, and it says so.
 *
 * @public shared with `refs.tsx`, which resolves a ref against several keys
 * before it has a URL to hand over — one definition of `target`/`rel`, because a
 * second one is how a link ends up handing the opener away.
 */
export function ExtLink({
  href,
  title,
  boxed,
  look,
  control,
  children,
}: {
  href: string;
  title?: string;
  boxed?: boolean;
  look?: ButtonLook;
  control?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <a
      className={
        control === true
          ? CONTROL_CLASS
          : look === undefined
            ? boxed === true
              ? 'ext-ref ref-out'
              : 'ext-ref'
            : buttonClass(look)
      }
      href={href}
      title={title}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

export function refLink(token: string, refUrls: Record<string, string>): ReactNode {
  const url = refUrls[token];
  return url ? <ExtLink href={url}>{token}</ExtLink> : token;
}

export function artifactHref(flag: { id: string; ref: string }, artifactUrls: Record<string, string>): string {
  if (/^https?:\/\//i.test(flag.ref)) return flag.ref;
  return artifactUrls[flag.id] ?? `/artifacts/${encodeURIComponent(flag.id)}`;
}

const REF_TOKEN = /#\d+/g;

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

export function untilTime(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.round((then - now) / 1000);
  if (secs <= 0) return 'any moment';
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

export function relAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((now - then) / 86_400_000);
  if (days < 1) return relTime(iso, now);
  if (days < 14) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function absDate(iso: string): string {
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return iso;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function agentUsageLine(a: {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
}): string | null {
  if (a.costUsd == null && a.inputTokens == null && a.outputTokens == null) return null;
  const parts: string[] = [];
  if (a.costUsd != null) parts.push(fmtUsd(a.costUsd));
  if (a.inputTokens != null || a.outputTokens != null)
    parts.push(`${fmtTokens(a.inputTokens ?? 0)}→${fmtTokens(a.outputTokens ?? 0)} tok`);
  if (a.numTurns != null) parts.push(`${a.numTurns} turns`);
  return parts.join(' · ');
}

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

export function decisionAttribution(
  d: { rule: string | null; admission?: string | null },
  rules: Record<string, { name: string; description: string; kind: string }>,
): {
  entries: { label: string; id: string; rule?: { name: string; description: string } }[];
  note?: string;
} {
  const entries: { label: string; id: string; rule?: { name: string; description: string } }[] = [];
  const proposer = d.rule ? rules[d.rule] : undefined;
  const outcome = d.admission ? rules[d.admission] : undefined;

  const preSplit = !d.admission && proposer?.kind === 'admission';

  if (d.rule && !preSplit) entries.push({ label: 'Proposed by', id: d.rule, rule: proposer });
  if (d.admission) entries.push({ label: 'Admitted as', id: d.admission, rule: outcome });
  if (preSplit) entries.push({ label: 'Outcome', id: d.rule!, rule: proposer });

  if (preSplit)
    return {
      entries,
      note: 'Recorded before proposer and outcome were separate columns — which rule was throttled is not in this row.',
    };
  if (entries.length === 0) return { entries, note: 'No dispatcher rule recorded for this decision.' };
  if (!d.rule)
    return { entries, note: 'No single proposing rule: this action folds signals from more than one concern.' };
  return { entries };
}

export function planIssueOf(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

export function partOriginOf(issueNumber: number | null, slug: string): string {
  return issueNumber === null ? '' : `issue:${issueNumber}:part:${slug}`;
}
