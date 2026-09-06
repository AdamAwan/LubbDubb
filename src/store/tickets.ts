import type { FeatureSummary, IssueState, TrackerItem } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

/**
 * Everything past the original `CREATE`: the mirror carries the harness's reading
 * (`tracking`) and the fields a work surface groups and filters by. `feature_colors`
 * is a fresh table but still declares an empty entry — new once does not keep a
 * table exempt from `ColumnMigrations`.
 */
export const TICKET_COLUMNS: ColumnMigrations = {
  tracker_items: {
    tracking: "TEXT NOT NULL DEFAULT 'live'",
    work_item_state: 'TEXT',
    issue_type: 'TEXT',
    parent_number: 'INTEGER',
    parent_title: 'TEXT',
    parent_known: 'INTEGER NOT NULL DEFAULT 0',
    last_read_at: 'TEXT',
  },
  // Mark that the one-time re-read of the history has happened; null on an existing database tells the sweep to ask from the anchor once. See TrackerSweepMark.restatedAt.
  tracker_sweep: { restated_at: 'TEXT' },
  feature_colors: {},
  feature_summaries: {},
};

/** How many hues the feature ladder has — fixed rather than one per feature, since a random colour can vanish against the panel. Repeats past twelve. */
const FEATURE_SLOTS = 12;

/**
 * What the world knows about an item that the tracker's history read does not: its
 * provider-native state, type, and feature. Passed in to the sweep rather than
 * fetched by it, since the snapshot has already paid for all three.
 */
export interface LiveTicketFacts {
  number: number;
  labels: string[];
  workItemState: string | null;
  issueType: string | null;
  /** The feature this hangs off; `null` is an orphan, `undefined` is a link that could not be read — collapsing the two would claim certainty we lack. */
  parent?: { number: number; title: string } | null;
}

/** Where the sweep has got to, and how far back it was ever allowed to look. */
export interface TrackerSweepMark {
  /** One month before the first sweep, stamped once and never moved — a rolling window would silently drop the far end of history every night. */
  anchorAt: string;
  /** The newest `changedAt` the mirror has actually taken in, or null before the first sweep lands. The next changed-since read asks from here. */
  sweptTo: string | null;
  /** When the mirror last re-read its whole history to fill in native states, or null if it never has. Stamped by the first sweep that lands, so a fresh database is restated by construction and an upgraded one pays for the re-read once. */
  restatedAt: string | null;
}

/**
 * The ticket mirror: every item the tracker's assignment filter has returned since
 * the harness first swept. A record, and the only kind of table that never deletes —
 * an item the tracker stops returning keeps its last-seen row; nothing in
 * `src/dispatcher/` reads it. The list read hands back the whole table with no
 * `WHERE`/`LIMIT`, since filtering, ordering and paging are a pure function over
 * these rows elsewhere (`src/tickets/ticketList.ts`).
 */
export class TicketStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * The sweep's mark, minting the frozen anchor on first call. `backfillMs` is only
   * ever read on that first call (`INSERT OR IGNORE`), so a later change to the
   * window does not move an existing deployment's floor.
   */
  ensureTrackerSweep(backfillMs: number): TrackerSweepMark {
    const ts = this.ctx.now();
    const anchor = new Date(new Date(ts).getTime() - backfillMs).toISOString();
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO tracker_sweep (id, anchor_at, swept_to, updated_at) VALUES (1, ?, NULL, ?)`)
      .run(anchor, ts);
    return this.readTrackerSweep() ?? { anchorAt: anchor, sweptTo: null, restatedAt: null };
  }

  /** The mark as it stands, or null on a database that has never swept. */
  readTrackerSweep(): TrackerSweepMark | null {
    const row = this.ctx.db.prepare(`SELECT anchor_at, swept_to, restated_at FROM tracker_sweep WHERE id = 1`).get() as
      | { anchor_at: string; swept_to: string | null; restated_at: string | null }
      | undefined;
    return row ? { anchorAt: row.anchor_at, sweptTo: row.swept_to, restatedAt: row.restated_at } : null;
  }

  /**
   * Write what a sweep saw, and move the high-water mark — one transaction, so a
   * failure part-way leaves the mark behind the rows, never ahead (ahead loses data
   * forever). The mark is the newest `changedAt` written, or `askedFrom` when nothing
   * came back — never the clock.
   */
  recordSweep(askedFrom: string, items: readonly TrackerItem[], live: readonly LiveTicketFacts[] = []): void {
    const ts = this.ctx.now();
    const upsert = this.ctx.db.prepare(
      `INSERT INTO tracker_items (number, title, labels, state, work_item_state, url, added_at, changed_at, first_seen_at, updated_at)
       VALUES (@number, @title, @labels, @state, @workItemState, @url, @addedAt, @changedAt, @ts, @ts)
       ON CONFLICT(number) DO UPDATE SET
         title=excluded.title,
         labels=excluded.labels,
         state=excluded.state,
         -- COALESCE, never assignment: a provider with no native states hands null every sweep, which would wipe what the live overlay wrote.
         work_item_state=COALESCE(excluded.work_item_state, tracker_items.work_item_state),
         url=excluded.url,
         added_at=excluded.added_at,
         changed_at=excluded.changed_at,
         updated_at=excluded.updated_at`,
    );
    // parent_known is written from the fact itself, not from whether parent_number is null: an orphan and an unreadable link are both a null id.
    const enrich = this.ctx.db.prepare(
      `UPDATE tracker_items SET
         tracking='live',
         labels=@labels,
         work_item_state=@workItemState,
         issue_type=@issueType,
         parent_number=CASE WHEN @parentKnown = 1 THEN @parentNumber ELSE parent_number END,
         parent_title=CASE WHEN @parentKnown = 1 THEN @parentTitle ELSE parent_title END,
         parent_known=CASE WHEN @parentKnown = 1 THEN 1 ELSE parent_known END,
         last_read_at=@ts,
         updated_at=@ts
       WHERE number=@number`,
    );
    const mark = this.ctx.db.prepare(
      // MAX, not assignment: a batch is not ordered, and one stale row would walk the mark backwards.
      `UPDATE tracker_sweep SET swept_to = MAX(COALESCE(swept_to, ''), ?), restated_at = COALESCE(restated_at, ?), updated_at = ? WHERE id = 1`,
    );
    this.ctx.db.transaction(() => {
      let newest = askedFrom;
      for (const item of items) {
        upsert.run({
          number: item.number,
          title: item.title,
          labels: JSON.stringify(item.labels),
          state: item.state,
          workItemState: item.workItemState,
          url: item.url,
          addedAt: item.createdAt,
          changedAt: item.changedAt,
          ts,
        });
        if (item.changedAt > newest) newest = item.changedAt;
      }

      for (const fact of live) {
        enrich.run({
          number: fact.number,
          labels: JSON.stringify(fact.labels),
          workItemState: fact.workItemState,
          issueType: fact.issueType,
          parentKnown: fact.parent === undefined ? 0 : 1,
          parentNumber: fact.parent?.number ?? null,
          parentTitle: fact.parent?.title ?? null,
          ts,
        });
      }

      // Freezing is by absence from the live set, skipped entirely when that set is empty — a provider down on boot hands back nothing, and freezing off that would retire the whole board silently.
      if (live.length > 0) {
        const stmt = this.ctx.db.prepare(
          `UPDATE tracker_items SET tracking='frozen', updated_at=?
           WHERE tracking='live' AND number NOT IN (${live.map(() => '?').join(',')})`,
        );
        stmt.run(ts, ...live.map((f) => f.number));
      }

      mark.run(newest, ts, ts);
    })();
  }

  /** The colour slot each of these features draws in, assigning one to any never seen. Least-used-first, ties on the lowest slot, deterministic. Assigned once, never moved. */
  ensureFeatureColors(numbers: readonly number[]): Map<number, number> {
    const rows = this.ctx.db.prepare(`SELECT number, slot FROM feature_colors`).all() as {
      number: number;
      slot: number;
    }[];
    const assigned = new Map(rows.map((r) => [r.number, r.slot]));
    const used = new Array<number>(FEATURE_SLOTS).fill(0);
    for (const slot of assigned.values()) if (slot >= 0 && slot < FEATURE_SLOTS) used[slot] = (used[slot] ?? 0) + 1;

    const ts = this.ctx.now();
    const insert = this.ctx.db.prepare(
      `INSERT OR IGNORE INTO feature_colors (number, slot, assigned_at) VALUES (?, ?, ?)`,
    );
    // Ascending, so two deployments that met the same features in the same order colour them the same way.
    for (const number of [...new Set(numbers)].sort((a, b) => a - b)) {
      if (assigned.has(number)) continue;
      let pick = 0;
      let fewest = used[0] ?? 0;
      for (let slot = 1; slot < FEATURE_SLOTS; slot += 1) {
        const count = used[slot] ?? 0;
        if (count < fewest) {
          pick = slot;
          fewest = count;
        }
      }
      used[pick] = fewest + 1;
      assigned.set(number, pick);
      insert.run(number, pick, ts);
    }
    return assigned;
  }

  /**
   * The goals closed and last touched since `since` — the spend trend's cohort. The
   * mirror is the closure source, not `world_events` (which never fires
   * `issue_closed`, since providers snapshot the open set only). `changed_at` is
   * last-modified, not a close date, so an item edited afterwards drifts to a later
   * week — a knowing trade, since the tracker gives no close date to mirror.
   */
  listTicketsClosedSince(since: string): TicketClosure[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT number, changed_at FROM tracker_items WHERE state = 'closed' AND changed_at >= ? ORDER BY number`,
      )
      .all(since) as { number: number; changed_at: string }[];
    return rows.map((r) => ({ number: r.number, closedAt: r.changed_at }));
  }

  /** Every mirrored item, newest tracker id first — already arrival order, since a tracker id is auto-incremental. No date parsing or timezone. */
  listTrackerItems(): MirroredTicket[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM tracker_items ORDER BY number DESC`).all() as TrackerItemRow[];
    return rows.map(rowToTicket);
  }

  /** The mirror's rows for these numbers only, read for the retained runs' `stale` marking. A number the mirror does not hold is simply absent. */
  readTrackerItems(numbers: readonly number[]): MirroredTicket[] {
    if (numbers.length === 0) return [];
    const rows = this.ctx.db
      .prepare(`SELECT * FROM tracker_items WHERE number IN (${numbers.map(() => '?').join(',')})`)
      .all(...numbers) as TrackerItemRow[];
    return rows.map(rowToTicket);
  }

  /**
   * Fold a label change the provider has just confirmed onto the mirrored rows —
   * `WorldStore.patchWorldLabels`'s half of the same click. Nothing else writes this
   * column between sweeps, so without it the toggle reads as broken. A number the
   * mirror does not hold is skipped; an empty label is a no-op.
   */
  patchTicketLabels(patch: TicketLabelPatch): void {
    if (patch.label === '' || patch.numbers.length === 0) return;
    const read = this.ctx.db.prepare(`SELECT labels FROM tracker_items WHERE number = ?`);
    const write = this.ctx.db.prepare(`UPDATE tracker_items SET labels = ?, updated_at = ? WHERE number = ?`);
    const ts = this.ctx.now();
    this.ctx.db.transaction(() => {
      for (const number of patch.numbers) {
        const row = read.get(number) as { labels: string } | undefined;
        if (row === undefined) continue;
        const next = new Set(parseLabels(row.labels));
        if (patch.present) next.add(patch.label);
        else next.delete(patch.label);
        write.run(JSON.stringify([...next]), ts, number);
      }
    })();
  }

  /**
   * Fold a work-item state the provider has just confirmed onto the mirrored row —
   * `WorldStore.patchWorldState`'s half of the same drop. Without it the card returns
   * to the column it was dragged out of. A number the mirror does not hold is
   * skipped by the `WHERE`.
   */
  patchTicketState(patch: { number: number; state: string }): void {
    this.ctx.db
      .prepare(`UPDATE tracker_items SET work_item_state = ?, updated_at = ? WHERE number = ?`)
      .run(patch.state, this.ctx.now(), patch.number);
  }

  /**
   * Write (or revise) a Feature's summary. Upsert on the container, so a re-write
   * revises one row rather than stacking accounts of the same Feature. `created_at`
   * survives an overwrite.
   */
  recordFeatureSummary(input: {
    originRef: string;
    standing: string;
    usable: string | null;
    blocked: string | null;
    remaining: string | null;
    standingKey: string;
    agentId: string;
    taskId: string;
  }): FeatureSummary {
    const ts = this.ctx.now();
    const prev = this.getFeatureSummary(input.originRef);
    const row: FeatureSummary = { ...input, createdAt: prev?.createdAt ?? ts, updatedAt: ts };
    this.ctx.db
      .prepare(
        `INSERT INTO feature_summaries
           (origin_ref, standing, usable, blocked, remaining, standing_key, agent_id, task_id, created_at, updated_at)
         VALUES (@originRef, @standing, @usable, @blocked, @remaining, @standingKey, @agentId, @taskId, @createdAt, @updatedAt)
         ON CONFLICT(origin_ref) DO UPDATE SET
           standing=excluded.standing, usable=excluded.usable, blocked=excluded.blocked,
           remaining=excluded.remaining, standing_key=excluded.standing_key, agent_id=excluded.agent_id,
           task_id=excluded.task_id, updated_at=excluded.updated_at`,
      )
      .run(row);
    return row;
  }

  getFeatureSummary(originRef: string): FeatureSummary | null {
    const row = this.ctx.db.prepare(`SELECT * FROM feature_summaries WHERE origin_ref=?`).get(originRef) as
      | FeatureSummaryRow
      | undefined;
    return row ? rowToFeatureSummary(row) : null;
  }

  /** Every summary on file. The board quotes them; the rule reads only their keys. */
  listFeatureSummaries(): FeatureSummary[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM feature_summaries`).all() as FeatureSummaryRow[];
    return rows.map(rowToFeatureSummary);
  }
}

/** A label change to fold onto the mirror: which items carry it now, on or off. One label per call, issues only — the mirror never holds pull requests. */
export interface TicketLabelPatch {
  numbers: readonly number[];
  label: string;
  present: boolean;
}

/** A goal the mirror holds as closed, and the instant it was last changed. */
export interface TicketClosure {
  number: number;
  /** `tracker_items.changed_at` — last-modified, read as a close date. See {@link TicketStore.listTicketsClosedSince}. */
  closedAt: string;
}

/** One mirrored item: the tracker's own fields, plus what the harness makes of it. */
export interface MirroredTicket extends TrackerItem {
  /** The sweep that first wrote this row; frozen. On the backfill, every row shares it. */
  firstSeenAt: string;
  /** `frozen` is an item that has left the tracker's open set; it keeps its last-seen fields and is no longer enriched, hence "live" and "kept" as two counts. */
  tracking: 'live' | 'frozen';
  issueType: string | null;
  /** The feature it hangs off. `undefined` means the link was never resolved (no hierarchy, or a failed read); `null` means the tracker says there is no parent. */
  parent?: { number: number; title: string } | null;
  /** The last sweep that saw this item in the live set. Null on a row only ever seen frozen. */
  lastReadAt: string | null;
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
  tracking: string | null;
  work_item_state: string | null;
  issue_type: string | null;
  parent_number: number | null;
  parent_title: string | null;
  parent_known: number | null;
  last_read_at: string | null;
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
    // A row written before this column existed reads null; `live` is correct since it was in the open set when last swept.
    tracking: r.tracking === 'frozen' ? 'frozen' : 'live',
    workItemState: r.work_item_state,
    issueType: r.issue_type,
    ...(r.parent_known === 1 ? { parent: parentOf(r) } : {}),
    lastReadAt: r.last_read_at,
  };
}

function parentOf(r: TrackerItemRow): { number: number; title: string } | null {
  return r.parent_number === null ? null : { number: r.parent_number, title: r.parent_title ?? `#${r.parent_number}` };
}

function parseLabels(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

interface FeatureSummaryRow {
  origin_ref: string;
  standing: string;
  usable: string | null;
  blocked: string | null;
  remaining: string | null;
  standing_key: string;
  agent_id: string;
  task_id: string;
  created_at: string;
  updated_at: string;
}

function rowToFeatureSummary(r: FeatureSummaryRow): FeatureSummary {
  return {
    originRef: r.origin_ref,
    standing: r.standing,
    usable: r.usable,
    blocked: r.blocked,
    remaining: r.remaining,
    standingKey: r.standing_key,
    agentId: r.agent_id,
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
