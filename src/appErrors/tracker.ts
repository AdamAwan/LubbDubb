import type { ErrorRecorder } from '../errorLog.js';
import { withDeadline } from '../primitives.js';
import { parseIssueOrigin } from '../issueOrigins.js';
import type { ActionSink, IssueKeyHit, IssueKeySink } from '../sink/actionSink.js';
import type { AppErrorTicketStore } from '../store/appErrorTickets.js';
import type { AppErrorRead, AppErrorState, AppErrorTicketSearch, AppErrorTracker } from '../types.js';
import type { AppErrorsPayload } from '../wire.js';

// → docs/spec/39-app-errors.md#the-tracker-lock

const MOVED: ReadonlySet<AppErrorState> = new Set<AppErrorState>(['new', 'returned', 'spiking']);

/** Neither tracker client sets a request timeout, and the pulse awaits this desk. */
const SEARCH_DEADLINE_MS = 30_000;

export function settleSearch(key: string, hits: readonly IssueKeyHit[], checkedAt: string): AppErrorTicketSearch {
  const open = hits.filter((h) => h.state === 'open').sort(byNumber);
  const closed = hits
    .filter((h) => h.state === 'closed')
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? '') || byNumber(b, a));
  const answer = open[0] ?? closed[0];
  return {
    key,
    status: answer === undefined ? 'none' : answer.state,
    ticketRef: answer?.ref ?? null,
    closedAt: answer?.state === 'closed' ? answer.closedAt : null,
    tickets: hits.length,
    detail: null,
    checkedAt,
  };
}

function failedSearch(key: string, detail: string, checkedAt: string): AppErrorTicketSearch {
  return { key, status: 'unknown', ticketRef: null, closedAt: null, tickets: 0, detail, checkedAt };
}

function byNumber(a: IssueKeyHit, b: IssueKeyHit): number {
  return (parseIssueOrigin(a.ref)?.issueNumber ?? 0) - (parseIssueOrigin(b.ref)?.issueNumber ?? 0);
}

function trackerOf(search: AppErrorTicketSearch | undefined, state: AppErrorState): AppErrorTracker | null {
  if (search === undefined) return null;
  const several = search.tickets > 1 ? `${String(search.tickets)} tickets carry this key` : null;
  switch (search.status) {
    case 'open':
      return { status: 'open', ticketRef: search.ticketRef, note: several };
    case 'closed': {
      const when = search.closedAt === null ? '' : ` ${search.closedAt.slice(0, 10)}`;
      return {
        status: 'closed',
        ticketRef: search.ticketRef,
        note: MOVED.has(state) ? `fixed${when}, error is back` : `closed${when}`,
      };
    }
    case 'none':
      return { status: 'none', ticketRef: null, note: null };
    case 'unknown':
      return { status: 'unknown', ticketRef: null, note: search.detail };
  }
}

export function withTrackers(payload: AppErrorsPayload, searches: readonly AppErrorTicketSearch[]): AppErrorsPayload {
  const byKey = new Map(searches.map((s) => [s.key, s]));
  return {
    ...payload,
    environments: payload.environments.map((env) => ({
      ...env,
      groups: env.groups.map((g) => ({ ...g, tracker: trackerOf(byKey.get(g.key), g.state) })),
    })),
  };
}

/**
 * The keys a pass owes a search: every moved group's, unless it was searched after the newest read.
 * A group that has not moved is never searched for on the pulse — the tab is about what moved.
 */
export function keysOwed(
  payload: AppErrorsPayload,
  searches: readonly AppErrorTicketSearch[],
  reads: readonly AppErrorRead[],
): string[] {
  const newest = reads.reduce((max, r) => (r.readAt > max ? r.readAt : max), '');
  const checked = new Map(searches.map((s) => [s.key, s.checkedAt]));
  const moved = new Set(
    payload.environments.flatMap((e) => e.groups.filter((g) => MOVED.has(g.state)).map((g) => g.key)),
  );
  return [...moved].filter((key) => {
    const at = checked.get(key);
    return at === undefined || at < newest;
  });
}

interface AppErrorTrackerDeps {
  tickets: AppErrorTicketStore;
  sink: ActionSink & Partial<IssueKeySink>;
  /** Whether a tracker is configured at all — `trackerCoordinates(config) !== null`, read live. */
  canFile: () => boolean;
  current: () => AppErrorsPayload;
  reads: () => AppErrorRead[];
  errors?: ErrorRecorder;
  now?: () => number;
}

export class AppErrorTrackerDesk {
  private readonly now: () => number;

  constructor(private readonly deps: AppErrorTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The sink a press files, labels and reopens through — the one this desk searches. */
  get sink(): ActionSink & Partial<IssueKeySink> {
    return this.deps.sink;
  }

  /** Whether a search can be made at all: a tracker to search, and a provider that can search it. */
  searchable(): boolean {
    return this.deps.canFile() && this.deps.sink.canSearchIssueKeys?.() === true;
  }

  async run(): Promise<void> {
    if (!this.searchable()) return;
    const owed = keysOwed(this.deps.current(), this.deps.tickets.listSearches(), this.deps.reads());
    if (owed.length > 0) await this.search(owed);
  }

  /** One batched search, recorded whole. A search that fails is `unknown` for every key it carried — never `none`. */
  async search(keys: readonly string[]): Promise<Map<string, AppErrorTicketSearch>> {
    const checkedAt = new Date(this.now()).toISOString();
    let answered: AppErrorTicketSearch[];
    try {
      const find = this.deps.sink.findIssuesByKeys;
      if (find === undefined || !this.searchable())
        throw new Error('no tracker this deployment files into can search by key');
      const hits = await withDeadline(
        find.call(this.deps.sink, keys),
        SEARCH_DEADLINE_MS,
        `the tracker did not answer the search within ${String(SEARCH_DEADLINE_MS / 1000)} seconds`,
      );
      answered = keys.map((key) => settleSearch(key, hits.get(key) ?? [], checkedAt));
    } catch (err) {
      const detail = `the tracker search failed: ${(err as Error).message}`;
      this.deps.errors?.record({ source: 'provider', message: `searching the tracker for app error keys: ${detail}` });
      answered = keys.map((key) => failedSearch(key, detail, checkedAt));
    }
    this.deps.tickets.recordSearches(answered);
    return new Map(answered.map((s) => [s.key, s]));
  }

  /** What a press filed or reopened, written before the next search would find it. */
  record(search: Omit<AppErrorTicketSearch, 'checkedAt'>): void {
    this.deps.tickets.recordSearches([{ ...search, checkedAt: new Date(this.now()).toISOString() }]);
  }
}
