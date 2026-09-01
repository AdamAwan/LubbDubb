import type { FeatureSummary, IssueState, TrackerItem } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

/**
 * Everything past the original `CREATE`: the mirror was a record of the tracker's
 * own five fields, and is now what every screen reads, so it carries the harness's
 * reading (`tracking`) and the fields a work surface groups and filters by.
 *
 * `feature_colors` is a fresh table and needs no entry — but a table being new
 * *once* does not keep it exempt, so it declares an empty one below.
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
  // The mark that the one-time re-read of the history has happened. On an existing
  // database it is null, which is what tells the sweep to ask from the anchor once
  // — see `TrackerSweepMark.restatedAt`.
  tracker_sweep: { restated_at: 'TEXT' },
  feature_colors: {},
  // Fresh with the feature summary, and declaring an empty entry for
  // `feature_colors`' stated reason: new *once* does not keep a table exempt.
  feature_summaries: {},
};

/**
 * How many hues the feature ladder has.
 *
 * A fixed ladder rather than a hue per feature: a colour picked at random has two
 * failure modes nothing catches — one that disappears against the panel, and two
 * features that land close enough to read as one. Twelve tested hues assigned
 * least-used-first cannot draw either, and past twelve the ladder repeats, which is
 * honest: a legend with forty colours is not a legend anyone reads.
 */
const FEATURE_SLOTS = 12;

/**
 * What the world knows about an item that the tracker's history read does not:
 * its provider-native state, its type, and the feature it hangs off.
 *
 * Passed *in* to the sweep rather than fetched by it, because the snapshot has
 * already paid for all three — the hierarchy hydration in particular is two batched
 * reads per pulse, and asking for it a second time here would double it for a
 * record.
 */
export interface LiveTicketFacts {
  number: number;
  labels: string[];
  workItemState: string | null;
  issueType: string | null;
  /**
   * The feature this hangs off; `null` is an orphan and `undefined` is a link that
   * could not be read. Kept apart all the way to the column, because collapsing
   * them tells a reader an item belongs to no feature when the truth is that we
   * could not tell.
   */
  parent?: { number: number; title: string } | null;
}

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
  /**
   * When the mirror last re-read its whole history to fill in the native states,
   * or **null** on a database that has not.
   *
   * `work_item_state` used to be written only by the live overlay, so every row
   * that had already left the tracker's open set carried no state at all — and a
   * state filter discovered from the mirror therefore could not reach any of them,
   * which is the one failure the discovery is there to prevent. Stamped by the
   * first sweep that lands, so a fresh database is restated by construction and
   * only an upgraded one pays for the re-read, once.
   */
  restatedAt: string | null;
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
 * **The list read hands back the whole table.** There is no `WHERE` on it and no
 * `LIMIT` (the trend's closure read below is the one narrowed query, and it asks
 * for a state and an instant — nothing a screen sorts by),
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
  recordSweep(askedFrom: string, items: readonly TrackerItem[], live: readonly LiveTicketFacts[] = []): void {
    const ts = this.ctx.now();
    const upsert = this.ctx.db.prepare(
      `INSERT INTO tracker_items (number, title, labels, state, work_item_state, url, added_at, changed_at, first_seen_at, updated_at)
       VALUES (@number, @title, @labels, @state, @workItemState, @url, @addedAt, @changedAt, @ts, @ts)
       ON CONFLICT(number) DO UPDATE SET
         title=excluded.title,
         labels=excluded.labels,
         state=excluded.state,
         -- COALESCE, never assignment: a provider with no native states hands null
         -- on every sweep, and assigning would wipe what the live overlay wrote.
         -- The history read is the *only* source for a row that has left the open
         -- set, and the two never disagree about one that has not -- both are the
         -- provider's own word for the same item.
         work_item_state=COALESCE(excluded.work_item_state, tracker_items.work_item_state),
         url=excluded.url,
         added_at=excluded.added_at,
         changed_at=excluded.changed_at,
         updated_at=excluded.updated_at`,
    );
    // The live overlay. `parent_known` is written from the fact itself rather than
    // from whether `parent_number` came out null, which is the whole point of the
    // flag: an orphan and an unreadable link are both a null id.
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
      // `MAX` rather than assignment: a batch is not ordered, and a provider that
      // returns one stale row would otherwise walk the mark backwards and re-read
      // the same window forever.
      // `restated_at` is stamped by whichever sweep lands first and never moves
      // again: a fresh database's first read is from the anchor and therefore
      // already carries every row's native state, and an upgraded one has just
      // paid for the same read once (see `TicketSweep.run`).
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

      // Freezing is by *absence from the live set*, and it is skipped entirely
      // when that set is empty. A provider whose snapshot failed hands back its
      // last good read, but one that is down on a first boot hands back nothing at
      // all — and freezing every row off that would retire the whole board in one
      // pulse, silently, which is the one way this can be wrong at scale. The same
      // reading the close-out sweep already takes for the same reason.
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

  /**
   * The colour slot each of these features draws in, assigning one to any that has
   * never been seen.
   *
   * Least-used-first rather than round-robin on the id: a deployment that has
   * retired half its features would otherwise pile the survivors onto a handful of
   * hues. Ties break on the lowest slot, so the assignment is deterministic and a
   * test can state it. Assigned once and never moved — a colour that changed
   * between sessions is worse than no colour at all.
   */
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
    // Ascending, so two deployments that met the same features in the same order
    // colour them the same way — an ordering the caller's map iteration would not
    // otherwise guarantee.
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
   * The goals that are closed and were last touched since `since` — the spend
   * trend's cohort ({@link module:spendTrend}).
   *
   * The mirror is the closure source rather than `world_events` because it is the
   * only one that has any: `issue_closed` needs an in-place `open → closed`
   * transition, and both real providers snapshot the open set only, so a closed
   * item simply leaves the world and the event never fires. `listTicketHistory`
   * asks by last-changed and returns both states, so the closures are already
   * here — on every existing database, with nothing to wait for.
   *
   * `changed_at` is the tracker's last-modified and not a close date, so a closed
   * item edited afterwards drifts to a later week. That is the trade taken
   * knowingly: the tracker gives no close date to mirror, and a cohort a few
   * items out of place is the whole trend's alternative to no trend at all.
   */
  listTicketsClosedSince(since: string): TicketClosure[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT number, changed_at FROM tracker_items WHERE state = 'closed' AND changed_at >= ? ORDER BY number`,
      )
      .all(since) as { number: number; changed_at: string }[];
    return rows.map((r) => ({ number: r.number, closedAt: r.changed_at }));
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

  /**
   * The mirror's rows for these numbers only — what the tracker last said about
   * an item the world no longer carries, read for the retained runs' `stale`
   * marking (`stateSnapshot`). Keyed rather than the whole list because the
   * snapshot is rebuilt on every dirty broadcast and a retained run is a handful of
   * rows out of a month of history. A number the mirror does not hold is simply
   * absent: a deployment with no mirror, or an item closed before the anchor.
   */
  readTrackerItems(numbers: readonly number[]): MirroredTicket[] {
    if (numbers.length === 0) return [];
    const rows = this.ctx.db
      .prepare(`SELECT * FROM tracker_items WHERE number IN (${numbers.map(() => '?').join(',')})`)
      .all(...numbers) as TrackerItemRow[];
    return rows.map(rowToTicket);
  }

  /**
   * Fold a label change the provider has just taken onto the mirrored rows —
   * `WorldStore.patchWorldLabels`' half of the same click, for the surface
   * that reads this table instead of the baseline.
   *
   * The Tickets tab is the only screen carrying an explicit **Unwatch**, and it
   * draws the toggle and its watch filter from `labels` here, not from the world.
   * Nothing else writes this column between sweeps: `TicketSweep` runs last in a
   * cycle, and the `runCycle('manual')` a watch route ends with coalesces away
   * while another cycle is in flight — most clicks on a busy fleet. So without
   * this the row an operator just un-watched goes on reporting `watched`, the
   * Unwatched filter cannot find it, and clicking again does exactly as little,
   * which is a toggle that reads as broken while the tag is long gone from the
   * tracker (issue #417).
   *
   * Observed fact arriving early rather than a guess, for `patchWorldLabels`'
   * reason: only ever called for a write the provider confirmed, and the next
   * sweep overlays the same labels back off the world. A number the mirror does
   * not hold is skipped — this is a record of what was *seen*, and a row invented
   * for it would be a ticket the tracker never handed us. An empty label is a
   * no-op: that is `labelPrefix: ''`, the gate off, where there is no tag at all.
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
   * Fold a work-item state the provider has just taken onto the mirrored row —
   * `WorldStore.patchWorldState`'s half of the same drop, for the surface that reads
   * this table instead of the baseline.
   *
   * The Tickets tab's card view groups its columns by `work_item_state` **here**, not
   * in the world: the board's rows come from `/api/tickets`. Nothing else writes this
   * column between sweeps, and `TicketSweep` runs last in a cycle that coalesces away
   * — so without this the card returns to the column it was dragged out of, which
   * reads as a drop that failed while the tracker has already taken it
   * ({@link patchTicketLabels}, issue #417).
   *
   * A number the mirror does not hold is skipped by the `WHERE`: this is a record of
   * what was *seen*, and a row invented for it would be a ticket the tracker never
   * handed us.
   */
  patchTicketState(patch: { number: number; state: string }): void {
    this.ctx.db
      .prepare(`UPDATE tracker_items SET work_item_state = ?, updated_at = ? WHERE number = ?`)
      .run(patch.state, this.ctx.now(), patch.number);
  }

  /**
   * Write (or revise) a Feature's summary.
   *
   * Upsert on the container, so a re-write revises one row rather than stacking
   * accounts of the same Feature — idempotence in the write rather than in a
   * read-then-check, exactly as `recordRetrospective` does it. `created_at`
   * survives an overwrite, so the row still dates the first time anybody said
   * where this Feature was.
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

/**
 * A label change to fold onto the mirror: which items carry it now, and whether it
 * went on or came off. One label per call and issues only, because that is the
 * shape of every caller and the shape of this table — the mirror holds tracker
 * items, and a pull request was never one.
 */
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
  /**
   * `frozen` is an item that has left the tracker's open set. It keeps every field
   * it was last seen with and is no longer enriched from the world, which is why
   * the tab counts *live* and *kept* as two numbers.
   */
  tracking: 'live' | 'frozen';
  issueType: string | null;
  /**
   * The feature it hangs off. `undefined` is the third value and not a tidier
   * `null`: it means the link was never resolved — no hierarchy, or a read that
   * failed — where `null` means the tracker says there is no parent.
   */
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
    // A row written before these columns existed reads `null`, and `live` is the
    // right thing to say about it: it was in the open set when it was last swept,
    // and the next sweep decides the question properly either way.
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
