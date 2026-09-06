import type { Issue, TicketRow } from './types.js';
import { watchBucket } from './worldBuckets.js';
import type { TagTone } from './components/tag.js';

// → docs/spec/17-cockpit.md

export interface TicketFeatureBlock {
  key: string;
  feature: { number: number; title: string; slot: number | null } | null;
  orphans: boolean;
  rows: TicketRow[];
}

export function featureBlocks(rows: readonly TicketRow[]): TicketFeatureBlock[] {
  const byFeature = new Map<number, TicketFeatureBlock>();
  const orphans: TicketRow[] = [];
  const untracked: TicketRow[] = [];

  for (const row of rows) {
    if (row.parent) {
      const existing = byFeature.get(row.parent.number);
      if (existing) existing.rows.push(row);
      else {
        byFeature.set(row.parent.number, {
          key: `f${row.parent.number}`,
          feature: { number: row.parent.number, title: row.parent.title, slot: row.featureSlot },
          orphans: false,
          rows: [row],
        });
      }
    } else if (row.parent === null) orphans.push(row);
    else untracked.push(row);
  }

  return [
    ...(untracked.length > 0 ? [{ key: 'untracked', feature: null, orphans: false, rows: untracked }] : []),
    ...byFeature.values(),
    ...(orphans.length > 0 ? [{ key: 'orphans', feature: null, orphans: true, rows: orphans }] : []),
  ];
}

export function isContainerType(issue: Issue, containerTypes: readonly string[]): boolean {
  if (issue.issueType === undefined) return false;
  const needle = issue.issueType.trim().toLowerCase();
  return containerTypes.some((t) => t.trim().toLowerCase() === needle);
}

export function cascadeNote(issue: Issue, containerTypes: readonly string[]): string {
  if (!isContainerType(issue, containerTypes)) return '';
  const kids = issue.children?.length ?? 0;
  return kids === 0 ? '' : ` and its ${kids} child item${kids === 1 ? '' : 's'}`;
}

export function watchReading(
  issue: { labels?: string[] } | null,
  row: Pick<TicketRow, 'watch'> | null,
  watchLabel: string,
): 'watched' | 'unwatched' {
  if (issue === null) return row?.watch ?? 'unwatched';
  return watchBucket(issue.labels, watchLabel);
}

export function issueTypeTone(issueType: string | null | undefined): TagTone | undefined {
  if (issueType === null || issueType === undefined) return undefined;
  switch (issueType.trim().toLowerCase()) {
    case 'bug':
    case 'defect':
      return 'red';
    case 'feature':
    case 'epic':
      return 'violet';
    case 'user story':
    case 'story':
    case 'product backlog item':
    case 'requirement':
      return 'green';
    case 'tech debt':
    case 'technical debt':
    case 'debt':
      return 'amber';
    case 'task':
      return 'blue';
    default:
      return undefined;
  }
}
