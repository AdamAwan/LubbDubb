import type { ErrorRecorder } from '../errorLog.js';
import type { LiveTicketFacts } from '../store/tickets.js';
import type { Store } from '../store/store.js';
import type { Issue, TrackerItem } from '../types.js';

// → docs/spec/13-jobs-and-tickets.md

const TICKET_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;

interface TicketHistorySource {
  listTicketHistory(since: string): Promise<TrackerItem[]>;
  readonly tracksTicketHistory: boolean;
}

export class TicketSweep {
  constructor(
    private readonly opts: {
      store: Store;
      source: TicketHistorySource;
      errors?: ErrorRecorder;
      backfillMs?: number;
    },
  ) {}

  get backfilling(): boolean {
    if (!this.opts.source.tracksTicketHistory) return false;
    return this.opts.store.tickets.readTrackerSweep()?.sweptTo == null;
  }

  get anchorAt(): string | null {
    return this.opts.store.tickets.readTrackerSweep()?.anchorAt ?? null;
  }

  async run(): Promise<void> {
    const { store, source, errors } = this.opts;
    if (!source.tracksTicketHistory) return;
    const mark = store.tickets.ensureTrackerSweep(this.opts.backfillMs ?? TICKET_BACKFILL_MS);
    const restating = mark.restatedAt === null && mark.sweptTo !== null;
    const askedFrom = restating ? mark.anchorAt : (mark.sweptTo ?? mark.anchorAt);
    try {
      const items = await source.listTicketHistory(askedFrom);
      store.tickets.recordSweep(askedFrom, items, liveFacts(store.world.getWorldBaseline()?.issues ?? []));
    } catch (err) {
      errors?.record({
        source: 'provider',
        message: `ticket sweep failed: ${(err as Error).message}`,
      });
    }
  }
}

function liveFacts(issues: readonly Issue[]): LiveTicketFacts[] {
  return issues
    .filter((issue) => issue.state === 'open')
    .map((issue) => ({
      number: issue.number,
      labels: issue.labels,
      workItemState: issue.workItemState ?? null,
      issueType: issue.issueType ?? null,
      ...(issue.parent === undefined ? {} : { parent: issue.parent === null ? null : relative(issue.parent) }),
    }));
}

function relative(parent: { number: number; title: string }): { number: number; title: string } {
  return { number: parent.number, title: parent.title };
}
