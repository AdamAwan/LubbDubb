import type { IssueState, TrackerItem } from '../types.js';
import type { StoreContext } from './context.js';

/** Where the sweep has got to, and how far back it was ever allowed to look. */
export interface TrackerSweepMark {
  /**
   * One month before the first sweep, stamped once and never moved.
   *
   * Frozen rather than rolling, which is the whole retention decision: a window
   * that moved with the clock would drop the far end of the history every night,
   * and it would do it silently — the tab would simply have fewer old rows each
   * morning with nothing anywhere saying they had been discarded.
   */
  anchorAt: string;
  /**
   * The newest `changedAt` the mirror has actually taken in, or null before the
   * first sweep lands. The next changed-since read asks from here.
   */
  sweptTo: string | null;
}

/**
 * The ticket mirror: every item the tracker's assignment filter has returned since
 * the harness first swept (issue #329).
 *
 * **A record, and the only kind of table that never deletes.** An item the tracker
 * stops returning — closed, untagged, reassigned away — keeps its last-seen row.
 * That is not laziness about cleanup; it is the point. The question the Tickets tab
 * answers is "what has this fleet been asked to do", and a history that forgets
 * cannot answer it. Nothing in `src/dispatcher/` reads any of this: the dispatcher
 * decides from the live issue list, which is open items by construction, and a rule
 * that could see a closed row would eventually act on one.
 *
 * **Reads hand back the whole table.** There is no `WHERE` here and no `LIMIT`,
 * because neither of the two things the list is filtered and ordered by is this
 * table's to know: the watch bucket is a function of the operator's label prefix
 * (`watchBucket`, shared with the backlog so the two cannot disagree) and cost is
 * `buildSpendGoals`' answer, which is the only authority on which goal a run's
 * money belongs to. Materialising either as a column would be a second copy of a
 * verdict that moves — the prefix is config, the spend changes every pulse — and
 * the drift would be invisible. So the filtering, ordering and paging are one pure
 * function over these rows (`src/tickets/ticketList.ts`), and what this owes is
 * that the rows are cheap to read whole: one line each, no body, bounded by the
 * tracker's assigned backlog rather than by time.
 */
export class TicketStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * The sweep's mark, minting the frozen anchor on first call.
   *
   * `backfillMs` is only ever read on the very first call — the `INSERT OR IGNORE`
   * is what makes that true, rather than a check the caller has to remember. A
   * later change to the window (a wider one, a shorter one) therefore does not move
   * an existing deployment's floor, which is correct twice: the rows below the new
   * floor are already kept, and a floor that moved would make "history from" a lie
   * on every screen that states it.
   */
  ensureTrackerSweep(backfillMs: number): TrackerSweepMark {
    const ts = this.ctx.now();
    const anchor = new Date(new Date(ts).getTime() - backfillMs).toISOString();
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO tracker_sweep (id, anchor_at, swept_to, updated_at) VALUES (1, ?, NULL, ?)`)
      .run(anchor, ts);
    return this.readTrackerSweep() ?? { anchorAt: anchor, sweptTo: null };
  }

  /** The mark as it stands, or null on a database that has never swept. */
  readTrackerSweep(): TrackerSweepMark | null {
    const row = this.ctx.db.prepare(`SELECT anchor_at, swept_to FROM tracker_sweep WHERE id = 1`).get() as
      | { anchor_at: string; swept_to: string | null }
      | undefined;
    return row ? { anchorAt: row.anchor_at, sweptTo: row.swept_to } : null;
  }

  /**
   * Write what a sweep saw, and move the high-water mark — one transaction, so a
   * failure part-way leaves the mark behind the rows rather than ahead of them.
   *
   * Ahead is the direction that loses data: a mark past items that were never
   * written means the next sweep asks from after them and they are missed forever,
   * on a table whose whole promise is that it does not forget. Behind merely costs
   * one re-read of rows the upsert is idempotent about.
   *
   * The mark is the newest `changedAt` **actually written**, or `askedFrom` when
   * nothing came back — never the clock. `askedFrom` is safe precisely because it
   * advances nothing: the next sweep asks from the same instant it just asked from,
   * so an item modified while the read was in flight is still picked up. What it
   * does record is that a sweep *completed*, which is the only thing separating a
   * mirror still filling for the first time from one whose tracker is simply empty
   * — and a tab that said "reading the last month" forever on an empty tracker
   * would be the very confusion the mark exists to resolve.
   */
  recordSweep(askedFrom: string, items: readonly TrackerItem[]): void {
    const ts = this.ctx.now();
    const upsert = this.ctx.db.prepare(
      `INSERT INTO tracker_items (number, title, labels, state, url, added_at, changed_at, first_seen_at, updated_at)
       VALUES (@number, @title, @labels, @state, @url, @addedAt, @changedAt, @ts, @ts)
       ON CONFLICT(number) DO UPDATE SET
         title=excluded.title,
         labels=excluded.labels,
         state=excluded.state,
         url=excluded.url,
         added_at=excluded.added_at,
         changed_at=excluded.changed_at,
         updated_at=excluded.updated_at`,
    );
    const mark = this.ctx.db.prepare(
      // `MAX` rather than assignment: a batch is not ordered, and a provider that
      // returns one stale row would otherwise walk the mark backwards and re-read
      // the same window forever.
      `UPDATE tracker_sweep SET swept_to = MAX(COALESCE(swept_to, ''), ?), updated_at = ? WHERE id = 1`,
    );
    this.ctx.db.transaction(() => {
      let newest = askedFrom;
      for (const item of items) {
        upsert.run({
          number: item.number,
          title: item.title,
          labels: JSON.stringify(item.labels),
          state: item.state,
          url: item.url,
          addedAt: item.createdAt,
          changedAt: item.changedAt,
          ts,
        });
        if (item.changedAt > newest) newest = item.changedAt;
      }
      mark.run(newest, ts);
    })();
  }

  /**
   * Every mirrored item, newest tracker id first — which is newest-added first,
   * since a tracker id is auto-incremental and therefore already arrival order. No
   * date parsing, and no timezone to get wrong.
   */
  listTrackerItems(): MirroredTicket[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM tracker_items ORDER BY number DESC`).all() as TrackerItemRow[];
    return rows.map(rowToTicket);
  }
}

/** One mirrored item: the tracker's own fields, plus when this harness first saw it. */
export interface MirroredTicket extends TrackerItem {
  /** The sweep that first wrote this row; frozen. On the backfill, every row shares it. */
  firstSeenAt: string;
}

interface TrackerItemRow {
  number: number;
  title: string;
  labels: string;
  state: string;
  url: string | null;
  added_at: string;
  changed_at: string;
  first_seen_at: string;
  updated_at: string;
}

function rowToTicket(r: TrackerItemRow): MirroredTicket {
  return {
    number: r.number,
    title: r.title,
    labels: parseLabels(r.labels),
    state: r.state === 'closed' ? 'closed' : ('open' as IssueState),
    url: r.url,
    createdAt: r.added_at,
    changedAt: r.changed_at,
    firstSeenAt: r.first_seen_at,
  };
}

function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}
