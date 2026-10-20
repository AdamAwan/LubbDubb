import type { ErrorRecorder } from '../errorLog.js';
import { utcDay, withDeadline } from '../primitives.js';
import { parseIssueOrigin } from '../issueOrigins.js';
import type { ActionSink, IssueKeyHit, IssueKeySink } from '../sink/actionSink.js';
import type { AppErrorTicketStore } from '../store/appErrorTickets.js';
import type { AppErrorRead, AppErrorState, AppErrorTicketSearch, AppErrorTracker } from '../types.js';
import type { AppErrorGroupView, AppErrorsPayload } from '../wire.js';
import { groupId } from './link.js';

// → docs/spec/39-app-errors.md#the-tracker-lock

const MOVED: ReadonlySet<AppErrorState> = new Set<AppErrorState>(['new', 'returned', 'spiking']);

/** Neither tracker client sets a request timeout, and a search still running holds every later pass. */
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
      const when = search.closedAt === null ? '' : ` ${utcDay(search.closedAt)}`;
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
 * The keys a pass owes a search, per environment: a moved group's, unless it was searched after its own
 * environment's newest read and has not changed since. A group that has not moved is never searched
 * for on the pulse — the tab is about what moved.
 */
export function keysOwed(
  payload: AppErrorsPayload,
  searches: readonly AppErrorTicketSearch[],
  changed: (group: AppErrorGroupView) => boolean = () => false,
): string[] {
  const checked = new Map(searches.map((s) => [s.key, s.checkedAt]));
  const owed = new Set<string>();
  for (const env of payload.environments) {
    const readAt = env.reading?.readAt ?? '';
    for (const group of env.groups) {
      if (!MOVED.has(group.state)) continue;
      const differs = changed(group);
      const at = checked.get(group.key);
      if (at === undefined || at < readAt || differs) owed.add(group.key);
    }
  }
  return [...owed];
}

interface AppErrorTrackerDeps {
  tickets: AppErrorTicketStore;
  sink: ActionSink & Partial<IssueKeySink>;
  /** Whether a tracker is configured at all — `trackerCoordinates(config) !== null`, read live. */
  canFile: () => boolean;
  /** The view without links or trackers: a search needs only each group's key and state. */
  view: () => AppErrorsPayload;
  reads: () => AppErrorRead[];
  errors?: ErrorRecorder;
  now?: () => number;
}

export class AppErrorTrackerDesk {
  private readonly now: () => number;
  /** Each environment's `readAt` when the desk last worked out what was owed. */
  private readonly seenReads = new Map<string, string>();
  /** Each moved group's state and last sighting when the desk last looked. */
  private readonly seenGroups = new Map<string, string>();
  private flight: Promise<void> | null = null;
  /** Keys a press is filing right now: two clicks in one cockpit are one bug. */
  private readonly filing = new Set<string>();

  constructor(private readonly deps: AppErrorTrackerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  canFile(): boolean {
    return this.deps.canFile();
  }

  /** Whether a search can be made at all: a tracker to search, and a provider that can search it. */
  searchable(): boolean {
    return this.deps.canFile() && this.deps.sink.canSearchIssueKeys?.() === true;
  }

  /**
   * Starts the pass's search and does not wait for it: the answer lands in the store, and a pulse that
   * finds one still running skips. Nothing is built unless some environment was read since the last pass.
   */
  run(): void {
    if (this.flight !== null || !this.searchable()) return;
    const reads = this.deps.reads();
    if (reads.every((r) => this.seenReads.get(r.environment) === r.readAt)) return;
    const view = this.deps.view();
    const owed = keysOwed(view, this.deps.tickets.listSearches(), (g) => this.moved(g));
    for (const r of reads) this.seenReads.set(r.environment, r.readAt);
    if (owed.length === 0) return;
    this.flight = this.search(owed)
      .then(
        () => undefined,
        (err: unknown) => {
          this.deps.errors?.record({
            source: 'provider',
            message: `recording a tracker search for app error keys: ${(err as Error).message}`,
          });
        },
      )
      .finally(() => {
        this.flight = null;
      });
  }

  /** @public resolves once the search a pass started has landed; tests read the store after it */
  async settled(): Promise<void> {
    await this.flight;
  }

  /** One batched search, recorded whole. A search that fails is `unknown` for every key it carried — never `none`. */
  async search(keys: readonly string[]): Promise<Map<string, AppErrorTicketSearch>> {
    const checkedAt = new Date(this.now()).toISOString();
    let answered: AppErrorTicketSearch[];
    try {
      const hits = await withDeadline(
        this.deps.sink.findIssuesByKeys!(keys),
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

  /** Claims a key for one press; false while another press holds it. */
  claim(key: string): boolean {
    if (this.filing.has(key)) return false;
    this.filing.add(key);
    return true;
  }

  release(key: string): void {
    this.filing.delete(key);
  }

  private moved(group: AppErrorGroupView): boolean {
    const id = groupId(group);
    const mark = `${group.state}\u0000${group.lastSeen}`;
    const before = this.seenGroups.get(id);
    this.seenGroups.set(id, mark);
    return before !== undefined && before !== mark;
  }
}
