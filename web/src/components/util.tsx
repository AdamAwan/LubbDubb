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

/**
 * A ref rendered as a captioned link rather than as its own token — for refs whose
 * canonical shape is machinery a human does not read (`issue:12:comment:456`),
 * where `refLink`'s "the token is the label" would put a ref string on screen.
 *
 * **Nothing is drawn unless the provider resolved it**, which is the whole rule
 * for the comments the harness maintains on a ticket (#171): a caption with no
 * link asserts something exists while giving nobody a way to read it, and that is
 * the outcome the issue ruled out. So a missing ref, an older server that sends
 * none, and a provider that builds no URLs all degrade to the same silence.
 */
export function refChip(
  ref: string | null | undefined,
  label: string,
  refUrls: Record<string, string>,
  opts: { title?: string; className?: string } = {},
): ReactNode {
  const url = ref ? refUrls[ref] : undefined;
  if (!url) return null;
  // Chip-shaped by default, because the surfaces that draw one sit in a row of
  // chips and buttons; a caller whose own frame supplies the sizing (the Goal
  // Floor draws inside an SVG node) passes its own class rather than fighting it.
  return (
    <a
      className={opts.className ?? 'ext-ref chip small'}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={opts.title}
    >
      {label}
    </a>
  );
}

/**
 * The URL to open a flagged artifact: an http(s) ref opens directly, a
 * worktree-relative path routes through the confined, sandboxed artifact route.
 *
 * The route sits *outside* the `/api` prefix and carries a per-flag capability in
 * its query string, because opening a chip is a top-level browser navigation and a
 * navigation cannot carry the bearer `Authorization` header (issue #129). The
 * server builds that URL — capability and all — into `artifactUrls`, so the cockpit
 * looks it up here (the same way `refLink` looks up `refUrls`) rather than
 * string-building it. A missing entry falls back to the bare path, which is what an
 * auth-off server serves anyway.
 */
export function artifactHref(flag: { id: string; ref: string }, artifactUrls: Record<string, string>): string {
  if (/^https?:\/\//i.test(flag.ref)) return flag.ref;
  return artifactUrls[flag.id] ?? `/artifacts/${encodeURIComponent(flag.id)}`;
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

/** Compact USD cost: "$0.42", "$12.30", "$142" — cents only while they matter. */
export function fmtUsd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** Compact token count: "830", "12.3k", "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** One-line usage summary for an agent ("$0.42 · 61.2k→3.4k tok · 7 turns"), or null when the runtime reported none. */
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

/**
 * What proposed a decision, and what became of it — the two readings the audit
 * row keeps in separate columns (`rule` / `admission`), resolved against the
 * rule book for display.
 *
 * One function for both skins rather than the fold written twice: the old-row
 * case below is a judgement about what a row *means*, and two renderers reaching
 * it independently is how they come to disagree about the same row.
 *
 * Three shapes reach here, and telling them apart is the whole job:
 *
 * - **Proposer, and an outcome that transformed it.** Both columns set: a
 *   throttled `issue-pickup` that became a `cooldown-escalate`.
 * - **An outcome with no proposer.** Only the branch note, which folds signals
 *   from several concerns and so was never any single rule's proposal.
 * - **An old row.** Written before the split, when one column carried both: the
 *   *outcome* sits in `rule` and there is nothing in `admission`. Which rule was
 *   throttled is not recorded and cannot be recovered, so it is named as an
 *   outcome and the gap is stated rather than filled.
 */
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

  // The pre-split shape: an admission id sitting in the proposer's column with
  // nothing beside it. Reading it as a proposer would assert something the row
  // never said.
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

/** The issue number a plan hangs off (`issue:12` → 12), or null for a shape we don't recognise. */
export function planIssueOf(originRef: string): number | null {
  const m = /^issue:(\d+)$/.exec(originRef);
  return m ? Number(m[1]) : null;
}

/** A part's dispatch origin — the key the "Up next" queue is joined on. */
export function partOriginOf(issueNumber: number | null, slug: string): string {
  return issueNumber === null ? '' : `issue:${issueNumber}:part:${slug}`;
}
