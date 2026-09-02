import { PHASE_ORDER, type SpendPhase } from '../spendInsights.js';
import type {
  PoolClaimsDocument,
  PoolClockDocument,
  PoolClockKind,
  PoolDigestDocument,
  PoolDigestRow,
} from '../types.js';
import { poolCauseLabel, poolPhaseLabel } from './aggregate.js';
import { POOL_RETENTION_DAYS, utcDay } from './digestArm.js';

/**
 * The human-readable companion: what a fleet's document says, for a person who
 * opened the repository rather than a harness that polled it.
 *
 * **Derived output, and never an input.** `fetch` names `claims.json` and
 * `digest.json` by name, so nothing here is ever read back — which is the whole
 * reason it is safe. A markdown file the importer parsed would be a second grammar
 * for one fact, free to disagree with the JSON the moment either side is edited,
 * and it would disagree silently. This renders the same {@link PoolClockDocument} the
 * JSON is serialised from and holds no state of its own, so the two cannot drift.
 *
 * **The digest companion summarises rather than transcribes.** Ninety days across
 * six sections is some thousands of rows, and a table of them is a file nobody
 * reads — which would defeat the one thing it is for. The trailing windows are the
 * read; `digest.json` remains the record, and the page says so.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-human-readable-companion`
 */

/** The trailing windows the digest companion totals over, in days. Widest last, and it is the retention. */
const WINDOWS: readonly number[] = [7, 30, POOL_RETENTION_DAYS];

/** Where one fleet's companion of a kind lives, relative to the pool's own prefix. */
export function poolMarkdownPath(fleetId: string, kind: PoolClockKind): string {
  return `fleets/${fleetId}/${kind}.md`;
}

/** One document as the page a person reads. Pure — same document in, same bytes out. */
export function renderPoolMarkdown(document: PoolClockDocument): string {
  const body = document.kind === 'claims' ? claimsBody(document) : digestBody(document);
  return `${[...heading(document), ...body]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function heading(document: PoolClockDocument): string[] {
  const source = `${document.kind}.json`;
  return [
    `# ${document.project} — ${document.kind === 'claims' ? 'what this fleet has vouched for' : 'daily digest'}`,
    '',
    // In the file rather than only in the spec: the person who finds this in a wiki
    // and edits it is the one who most needs telling that the next publish wins.
    `<!-- Derived from ${source} by LubbDubb ${document.harnessVersion}. Written whole on every publish, so an edit here is overwritten. -->`,
    '',
    `**Fleet** \`${document.fleetId}\` · **Project** \`${document.project}\` · ` +
      `**Published** ${timestamp(document.publishedAt)} · **Harness** ${document.harnessVersion}`,
    '',
  ];
}

function claimsBody(document: PoolClaimsDocument): string[] {
  if (document.claims.length === 0) return ['This fleet has vouched for nothing yet.'];
  const lines = [
    `${document.claims.length} claim${document.claims.length === 1 ? '' : 's'}, each ruled on by an operator here. ` +
      // Said in the file for the reason the spec says it: the counts are the loudest
      // numbers on the page, and a reader who takes them as a threshold has the
      // corroboration gate exactly backwards.
      `The counts are this fleet's own — a reading, and never a trigger.`,
    '',
  ];
  for (const claim of document.claims) {
    const facts = [
      claim.where === null ? null : `**Where** ${claim.where}`,
      `**Vouched** ${claim.vouchedAt.slice(0, 10)}`,
      `**Corroborations** ${claim.corroborations}`,
      `**Disputes** ${claim.disputes}`,
    ].filter((fact): fact is string => fact !== null);
    lines.push(`## ${oneLine(claim.claim)}`, '', facts.join(' · '), '');
    if (claim.evidence.length > 0) {
      lines.push('<details><summary>What the agents said</summary>', '');
      for (const word of claim.evidence) lines.push(`- ${oneLine(word)}`);
      lines.push('', '</details>', '');
    }
  }
  return lines;
}

/** One section of the digest: where its rows are, what its key means, and what it counts. */
interface DigestSection {
  rows: (document: PoolDigestDocument) => PoolDigestRow[];
  title: string;
  /** The key column's header, or null for the two sections that have one row and no key. */
  column: string | null;
  label: (key: string) => string;
  counts: string;
  /** False where every row's cost is null by construction — a column of dashes is worse than no column. */
  costed: boolean;
  /**
   * A line under the table, for a section whose numbers mean something narrower
   * than their heading says. Said in the file rather than only in the spec: the
   * person reading a table in a wiki is the one who has to know what it counts, and
   * they are not the person who read the spec.
   */
  caveat?: string;
}

const SECTIONS: readonly DigestSection[] = [
  {
    rows: (d) => d.byPhase,
    title: 'Where the money went',
    column: 'Phase',
    label: (key) => poolPhaseLabel(key),
    counts: 'Runs',
    costed: true,
  },
  {
    rows: (d) => d.byCause,
    title: 'Why the fleet came back',
    column: 'Kind · cause · guard',
    label: (key) => poolCauseLabel(key),
    counts: 'Accounts',
    costed: true,
  },
  {
    rows: (d) => d.byCheck,
    title: 'Which checks cost the most',
    column: 'Check',
    label: (key) => `\`${key}\``,
    counts: 'Accounts',
    costed: true,
  },
  {
    rows: (d) => d.unaccounted,
    title: 'Return dispatches that filed no account',
    column: null,
    label: () => '',
    counts: 'Dispatches',
    costed: false,
  },
  {
    rows: (d) => d.unmeasured,
    title: 'Runs that reported no usage',
    column: null,
    label: () => '',
    counts: 'Runs',
    costed: false,
  },
  {
    rows: (d) => d.byFault,
    title: 'What went wrong in the harness',
    column: 'Source',
    label: (key) => key,
    counts: 'Faults',
    // A fault has no cost figure anywhere in the harness, and a column of dashes is
    // worse than no column.
    costed: false,
    caveat:
      '_Counted from the fault log as it stands. Clearing it in the cockpit drops these rows from the next ' +
      'publish, so a quiet quarter here may be a cleared one. Nothing sums this across fleets: a fault is ' +
      'this harness on this machine._',
  },
];

function digestBody(document: PoolDigestDocument): string[] {
  const today = utcDay(document.publishedAt);
  const lines = [
    `Totals over the trailing windows. The day-by-day series is in \`digest.json\` — this is the read, not the record.`,
    '',
    // The same discipline the aggregator states, stated where a person reads it: a
    // day that is not over drags an average down by up to a whole day's width.
    `A partial day — the day this was published — counts in a total and never in an average.`,
    '',
  ];
  for (const section of SECTIONS) {
    lines.push(`## ${section.title}`, '');
    const rows = rollUp(section.rows(document), today);
    lines.push(...(rows.length === 0 ? ['Nothing recorded in the last ninety days.'] : table(section, rows)), '');
    // The caveat rides the empty section too, and that is the case it is most for:
    // an empty faults table is exactly what a cleared log looks like.
    if (section.caveat !== undefined) lines.push(section.caveat, '');
  }
  return lines;
}

/** One key's totals, one per window, widest window last. */
interface RolledKey {
  key: string;
  windows: { count: number; costUsd: number | null }[];
}

/**
 * The days folded into the trailing windows.
 *
 * `today` is the document's own publish day rather than this machine's: a companion
 * re-rendered on a reader's clock would put the origin's newest day outside its own
 * seven-day window the moment the two are on different sides of midnight.
 */
function rollUp(rows: readonly PoolDigestRow[], today: string): RolledKey[] {
  const cutoffs = WINDOWS.map((window) => daysBefore(today, window - 1));
  const byKey = new Map<string, RolledKey>();
  for (const row of rows) {
    let rolled = byKey.get(row.key);
    if (rolled === undefined) {
      rolled = { key: row.key, windows: WINDOWS.map(() => ({ count: 0, costUsd: null })) };
      byKey.set(row.key, rolled);
    }
    cutoffs.forEach((cutoff, index) => {
      if (row.day < cutoff) return;
      const window = rolled.windows[index];
      if (window === undefined) return;
      window.count += row.count;
      // Null stays null while every contributing row was null — `$0.00` would be a
      // claim that the fleet worked for free, which is `foldPoolDigest`'s rule.
      if (row.costUsd !== null) window.costUsd = round((window.costUsd ?? 0) + row.costUsd);
    });
  }
  return [...byKey.values()].sort(widestFirst);
}

/**
 * Phases in funnel order so the section reads as the pipeline it partitions;
 * everything else costliest first, which is the question those sections answer.
 */
function widestFirst(a: RolledKey, b: RolledKey): number {
  const [left, right] = [PHASE_ORDER.indexOf(a.key as SpendPhase), PHASE_ORDER.indexOf(b.key as SpendPhase)];
  if (left !== -1 && right !== -1) return left - right;
  return (b.windows.at(-1)?.count ?? 0) - (a.windows.at(-1)?.count ?? 0);
}

function table(section: DigestSection, rows: readonly RolledKey[]): string[] {
  const keyed = section.column !== null;
  const headers = [
    ...(keyed ? [section.column ?? ''] : []),
    ...WINDOWS.flatMap((window) => [`${section.counts} ${window}d`, ...(section.costed ? [`Cost ${window}d`] : [])]),
  ];
  const rules = headers.map((_header, index) => (keyed && index === 0 ? '---' : '--:'));
  return [
    row(headers),
    row(rules),
    ...rows.map((rolled) =>
      row([
        ...(keyed ? [section.label(rolled.key)] : []),
        ...rolled.windows.flatMap((window) => [
          String(window.count),
          ...(section.costed ? [money(window.costUsd)] : []),
        ]),
      ]),
    ),
  ];
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function money(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The UTC day `days` before this one. Whole days throughout, because the bucket is a day. */
function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function timestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * A claim's own words on one line.
 *
 * A claim is free text an agent wrote, and a newline inside one would end the
 * heading or the list item it is being drawn as — the rest of the sentence then
 * renders as body text under a truncated heading, which reads as a claim the fleet
 * did not make.
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
