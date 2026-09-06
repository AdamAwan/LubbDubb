import type { MirroredTicket } from '../store/tickets.js';
import { isWatched } from '../watchLabels.js';
import type {
  TicketFeatureFacet,
  TicketOrder,
  TicketRow,
  TicketStateFacet,
  TicketStateFilter,
  TicketTrackingFilter,
  TicketWatchFilter,
} from '../wire.js';

// → docs/spec/13-jobs-and-tickets.md

export const TICKET_PAGE = 40;

export const NO_FEATURE = 'none';

interface TicketQuery {
  watch: TicketWatchFilter;
  tracking: TicketTrackingFilter;
  state: TicketStateFilter;
  feature: number | typeof NO_FEATURE | null;
  order: TicketOrder;
  cursor: string | null;
}

interface TicketPage {
  rows: TicketRow[];
  total: number;
  kept: number;
  live: number;
  totalCostUsd: number;
  nextCursor: string | null;
  states: TicketStateFacet[];
  features: TicketFeatureFacet[];
  orphanCount: number;
}

interface BuildInput {
  items: readonly MirroredTicket[];
  costs: ReadonlyMap<number, number>;
  outcomes: ReadonlyMap<number, string>;
  featureSlots: ReadonlyMap<number, number>;
  pickupStates: readonly string[];
  watchLabel: string;
  query: TicketQuery;
}

export function buildTicketPage(input: BuildInput): TicketPage {
  const { items, costs, outcomes, featureSlots, pickupStates, watchLabel, query } = input;

  const matching: TicketRow[] = [];
  let totalCostUsd = 0;
  let live = 0;
  const stateCounts = new Map<string, { count: number; live: number }>();
  const featureCounts = new Map<number, { title: string; count: number }>();
  let orphanCount = 0;

  for (const item of items) {
    if (item.tracking === 'live') live += 1;
    if (item.workItemState !== null) {
      const seen = stateCounts.get(item.workItemState);
      stateCounts.set(item.workItemState, {
        count: (seen?.count ?? 0) + 1,
        live: (seen?.live ?? 0) + (item.tracking === 'live' ? 1 : 0),
      });
    }
    if (item.parent) {
      const seen = featureCounts.get(item.parent.number);
      featureCounts.set(item.parent.number, { title: item.parent.title, count: (seen?.count ?? 0) + 1 });
    } else if (item.parent === null) {
      orphanCount += 1;
    }

    if (query.tracking !== 'any' && item.tracking !== query.tracking) continue;
    if (query.state !== 'any' && item.workItemState !== query.state) continue;
    if (query.feature !== null) {
      if (query.feature === NO_FEATURE) {
        if (item.parent !== null) continue;
      } else if (item.parent?.number !== query.feature) continue;
    }
    const watch = isWatched(item.labels, watchLabel) ? 'watched' : 'unwatched';
    if (query.watch !== 'any' && watch !== query.watch) continue;
    const costUsd = costs.get(item.number) ?? null;
    totalCostUsd += costUsd ?? 0;
    matching.push({
      number: item.number,
      title: item.title,
      state: item.state,
      watch,
      labels: item.labels,
      costUsd,
      outcome: outcomes.get(item.number) ?? null,
      addedAt: item.createdAt,
      changedAt: item.changedAt,
      tracking: item.tracking,
      workItemState: item.workItemState,
      issueType: item.issueType,
      ...(item.parent === undefined ? {} : { parent: item.parent }),
      featureSlot: item.parent ? (featureSlots.get(item.parent.number) ?? null) : null,
    });
  }

  if (query.order === 'cost') {
    matching.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.number - a.number);
  } else if (query.order === 'changed') {
    matching.sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : b.number - a.number));
  }

  const start = query.cursor === null ? 0 : afterCursor(matching, query.cursor, query.order);
  const rows = matching.slice(start, start + TICKET_PAGE);
  const end = start + rows.length;
  const last = rows[rows.length - 1];
  return {
    rows,
    total: matching.length,
    kept: items.length,
    live,
    totalCostUsd: round(totalCostUsd),
    nextCursor: end < matching.length && last ? cursorFor(last, query.order) : null,
    states: [...stateCounts]
      .map(([state, seen]) => ({ ...seen, state, pickup: pickupStates.includes(state) }))
      .sort((a, b) => b.count - a.count || a.state.localeCompare(b.state)),
    features: [...featureCounts]
      .map(([number, f]) => ({ number, title: f.title, slot: featureSlots.get(number) ?? 0, count: f.count }))
      .sort((a, b) => b.count - a.count || a.number - b.number),
    orphanCount,
  };
}

function cursorFor(row: TicketRow, order: TicketOrder): string {
  if (order === 'cost') return `${row.costUsd ?? -1}:${row.number}`;
  if (order === 'changed') return `${row.changedAt}:${row.number}`;
  return `${row.number}`;
}

function afterCursor(rows: readonly TicketRow[], cursor: string, order: TicketOrder): number {
  const index = rows.findIndex((row) => cursorFor(row, order) === cursor);
  return index === -1 ? 0 : index + 1;
}

function round(usd: number): number {
  return Math.round(usd * 100) / 100;
}
