import { PHASE_ORDER, type SpendPhase } from '../spendInsights.js';
import type { PoolClockDocument, PoolClockKind, PoolDigestDocument, PoolDigestRow } from '../types.js';
import { throughputMeasureLabel } from '../throughputInsights.js';
import { poolCauseLabel, poolPhaseLabel, poolUsageLabel } from './aggregate.js';
import { POOL_RETENTION_DAYS, utcDay } from './digestArm.js';

// → docs/spec/28-cross-fleet-pool.md

const WINDOWS: readonly number[] = [7, 30, POOL_RETENTION_DAYS];

export function poolMarkdownPath(fleetId: string, kind: PoolClockKind): string {
  return `fleets/${fleetId}/${kind}.md`;
}

export function renderPoolMarkdown(document: PoolClockDocument): string {
  const body = digestBody(document);
  return `${[...heading(document), ...body]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}

function heading(document: PoolClockDocument): string[] {
  const source = `${document.kind}.json`;
  return [
    `# ${document.project} — daily digest`,
    '',
    `<!-- Derived from ${source} by LubbDubb ${document.harnessVersion}. Written whole on every publish, so an edit here is overwritten. -->`,
    '',
    `**Fleet** \`${document.fleetId}\` · **Project** \`${document.project}\` · ` +
      `**Published** ${timestamp(document.publishedAt)} · **Harness** ${document.harnessVersion}`,
    '',
  ];
}

interface DigestSection {
  rows: (document: PoolDigestDocument) => PoolDigestRow[];
  title: string;
  column: string | null;
  label: (key: string) => string;
  counts: string;
  costed: boolean;
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
    rows: (d) => d.byUsage,
    title: 'What a person did',
    column: 'Subject · verb',
    label: (key) => poolUsageLabel(key),
    counts: 'Times',
    costed: false,
    caveat:
      '_Counted from what the cockpit witnessed on the click. Acts a table already records — approving a plan, ' +
      'waiving a check — are swept by the operator ledger in this fleet’s own console and are deliberately not ' +
      'here: `src/usage/events.ts` says which are which. A quiet row is a control nobody reached, never a fleet ' +
      'nobody worked._',
  },
  {
    rows: (d) => d.byThroughput,
    title: 'What came out',
    column: 'Measure',
    label: (key) => throughputMeasureLabel(key),
    counts: 'Times',
    costed: false,
    caveat:
      '_Counted from this fleet’s activity feed, and true of this fleet whatever its world was scoped ' +
      'to. What crosses into the pool’s summed tables is narrower: a slice the provider did not filter ' +
      'to this operator is a fact about the **repository**, which every fleet watching it also reports, ' +
      'so summing it would count watchers rather than work. `poolableThroughput` in `digest.json` names ' +
      'the rows this fleet published as its own._',
  },
  {
    rows: (d) => d.byFault,
    title: 'What went wrong in the harness',
    column: 'Source',
    label: (key) => key,
    counts: 'Faults',
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
    `A partial day — the day this was published — counts in a total and never in an average.`,
    '',
  ];
  for (const section of SECTIONS) {
    lines.push(`## ${section.title}`, '');
    const rows = rollUp(section.rows(document), today);
    lines.push(...(rows.length === 0 ? ['Nothing recorded in the last ninety days.'] : table(section, rows)), '');
    if (section.caveat !== undefined) lines.push(section.caveat, '');
  }
  return lines;
}

interface RolledKey {
  key: string;
  windows: { count: number; costUsd: number | null }[];
}

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
      if (row.costUsd !== null) window.costUsd = round((window.costUsd ?? 0) + row.costUsd);
    });
  }
  return [...byKey.values()].sort(widestFirst);
}

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

function daysBefore(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function timestamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
