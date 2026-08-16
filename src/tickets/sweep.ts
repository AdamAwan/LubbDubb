import type { ErrorRecorder } from '../errorLog.js';
import type { Store } from '../store/store.js';
import type { TrackerItem } from '../types.js';

/** How far back the very first sweep reaches. One month, and it is never re-read. */
const TICKET_BACKFILL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Where the sweep reads its items from — the composite's routed
 * {@link TicketHistoryCapable} call, narrowed to what this needs so a test can
 * hand it a list without building a connector.
 */
interface TicketHistorySource {
  listTicketHistory(since: string): Promise<TrackerItem[]>;
  readonly tracksTicketHistory: boolean;
}

/**
 * Keeping the ticket mirror current (issue #329).
 *
 * **Backfill one month, then keep everything.** Two rules that pull in opposite
 * directions, and the tension is the whole design:
 *
 * - The floor is *anchored*, stamped one month before the first sweep and frozen
 *   thereafter ({@link Store.ensureTrackerSweep}). A rolling month would quietly
 *   drop the far end of the history every night — the tab would just have fewer old
 *   rows each morning, with nothing saying they had gone.
 * - Nothing is ever deleted. The mirror is a record of what was seen, not a copy of
 *   what the tracker currently says.
 *
 * After the first sweep the read is incremental: each one asks for what has changed
 * since the newest `changedAt` the mirror actually took in, so a pulse costs a page
 * or two rather than a re-list of the tracker. That is also why the floor is a
 * **floor and not a filter** — the provider is asked by last-changed, so an item
 * filed long before the anchor that somebody touched last week arrives on an
 * ordinary sweep and is then kept like any other row. The history is "everything
 * since the anchor, plus whatever older work is still alive", and a reader who
 * expects a clean cut-off will one day find an older ticket in the list and think
 * the floor is broken.
 *
 * A record, not a decision: no rule under `src/dispatcher/` reads any of this, and
 * the tab it feeds is a lens.
 */
export class TicketSweep {
  constructor(
    private readonly opts: {
      store: Store;
      source: TicketHistorySource;
      errors?: ErrorRecorder;
      /** Overridable so a test can sweep a narrower window than a month. */
      backfillMs?: number;
    },
  ) {}

  /**
   * Whether the mirror is still filling for the first time — what lets the tab say
   * "reading the last month" instead of rendering an empty list, which is
   * indistinguishable from a broken one.
   */
  get backfilling(): boolean {
    if (!this.opts.source.tracksTicketHistory) return false;
    return this.opts.store.readTrackerSweep()?.sweptTo == null;
  }

  /** The frozen floor, or null before the first sweep has minted one. */
  get anchorAt(): string | null {
    return this.opts.store.readTrackerSweep()?.anchorAt ?? null;
  }

  /**
   * One sweep. Called every pulse, and cheap after the first.
   *
   * Failures are recorded and swallowed rather than thrown, for the reason every
   * provider read in this codebase is: the mirror is a lens nothing dispatches from,
   * and a tracker that refused us must not cost the cycle its work. The high-water
   * mark is only moved by rows that were actually written, so a failed sweep is
   * retried whole on the next pulse rather than leaving a hole.
   */
  async run(): Promise<void> {
    const { store, source, errors } = this.opts;
    // Nothing to sweep from — the `fake` provider, or a deployment whose issues
    // provider predates the capability. No anchor is minted either: stamping one
    // now would freeze a floor a month before a sweep that never ran, and the tab
    // would state a history it does not have.
    if (!source.tracksTicketHistory) return;
    const mark = store.ensureTrackerSweep(this.opts.backfillMs ?? TICKET_BACKFILL_MS);
    const askedFrom = mark.sweptTo ?? mark.anchorAt;
    try {
      const items = await source.listTicketHistory(askedFrom);
      // Recorded even when the tracker had nothing to give: a completed sweep that
      // found nothing and a sweep that has not run are different states, and only
      // the mark tells them apart.
      store.recordSweep(askedFrom, items);
    } catch (err) {
      errors?.record({
        source: 'provider',
        message: `ticket sweep failed: ${(err as Error).message}`,
      });
    }
  }
}
