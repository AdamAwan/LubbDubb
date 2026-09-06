import type { Issue, TicketRow, TicketStateFacet } from './types.js';
import { watchBucket } from './worldBuckets.js';

// → docs/spec/13-jobs-and-tickets.md

export interface BoardColumn {
  state: string;
  count: number;
  live: number;
  pickup: boolean;
  empty: boolean;
}

export function boardColumns(
  boardStates: readonly string[],
  facets: readonly TicketStateFacet[],
  pickup: readonly string[],
): { columns: BoardColumn[]; unlisted: TicketStateFacet[] } {
  const byState = new Map(facets.map((facet) => [facet.state, facet]));
  const gate = new Set(pickup);

  if (boardStates.length === 0) {
    return {
      columns: facets.map((facet) => ({
        state: facet.state,
        count: facet.count,
        live: facet.live,
        pickup: gate.has(facet.state),
        empty: false,
      })),
      unlisted: [],
    };
  }

  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const raw of boardStates) {
    const state = raw.trim();
    if (state === '' || seen.has(state)) continue;
    seen.add(state);
    wanted.push(state);
  }

  return {
    columns: wanted.map((state) => {
      const facet = byState.get(state);
      return {
        state,
        count: facet?.count ?? 0,
        live: facet?.live ?? 0,
        pickup: gate.has(state),
        empty: facet === undefined,
      };
    }),
    unlisted: facets.filter((facet) => !seen.has(facet.state)),
  };
}

type CardReasonTone = 'held' | 'outcome' | 'pickup' | 'frozen' | 'unwatched';

export function cardReason(
  row: TicketRow,
  issue: Issue | null,
  watchLabel: string,
  frozenAge: string,
): { tone: CardReasonTone; words: string } {
  const watched = (issue === null ? row.watch : watchBucket(issue.labels, watchLabel)) === 'watched';

  if (watched && issue?.appraisal?.verdict === 'unclear') {
    return { tone: 'held', words: 'held at intake — the appraisal is unclear, so nothing under it moves' };
  }
  if (row.outcome !== null) return { tone: 'outcome', words: row.outcome };

  const reason = issue?.pickup.reasons[0];
  if (reason !== undefined) return { tone: 'pickup', words: reason };

  if (row.tracking === 'frozen') {
    return { tone: 'frozen', words: `frozen${frozenAge === '' ? '' : ` · last change ${frozenAge}`}` };
  }
  if (!watched) return { tone: 'unwatched', words: 'not watched — nobody has opted this in' };
  return { tone: 'pickup', words: 'waiting to be picked up' };
}

type DropTone = 'none' | 'ok' | 'warn' | 'stop';

export interface StateRules {
  pickup: string[];
  inProgress: string | null;
  inReview: string | null;
  returnsTo: string | null;
}

export function dropWarning(
  column: BoardColumn,
  from: string | null,
  rules: StateRules | null,
): { tone: DropTone; words: string } {
  if (from !== null && column.state === from) return { tone: 'none', words: 'where it is now' };
  if (rules === null) {
    return { tone: 'none', words: 'no state gate is configured — this changes the tracker and nothing else' };
  }

  const parts: string[] = [
    column.pickup
      ? 'a pickup state — the fleet can work this'
      : 'leaves the pickup states — the fleet stops picking this up',
  ];
  let tone: DropTone = column.pickup ? 'ok' : 'stop';

  if (column.state === rules.inProgress) {
    parts.push('a rule moves items here itself once an agent starts');
  }
  if (column.state === rules.inReview && rules.returnsTo !== null) {
    tone = 'warn';
    parts.push(`work-item-back-to-pickup returns it to "${rules.returnsTo}" if a verdict reports work outstanding`);
  }
  if (column.live === 0 && column.count > 0) {
    if (tone !== 'stop') tone = 'warn';
    parts.push('nothing under this state is still in the tracker’s open set');
  }

  return { tone, words: parts.join(' · ') };
}
