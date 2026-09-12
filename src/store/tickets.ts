import type { FeatureSummary, IssueState, TrackerItem } from '../types.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md

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
  tracker_sweep: { restated_at: 'TEXT' },
  feature_colors: {},
  feature_summaries: {},
};

const FEATURE_SLOTS = 12;

export interface LiveTicketFacts {
  number: number;
  labels: string[];
  workItemState: string | null;
  issueType: string | null;
  parent?: { number: number; title: string } | null;
}

interface TrackerSweepMark {
  anchorAt: string;
  sweptTo: string | null;
  restatedAt: string | null;
}

export class TicketStore {
  constructor(private readonly ctx: StoreContext) {}

  ensureTrackerSweep(backfillMs: number): TrackerSweepMark {
    const ts = this.ctx.now();
    const anchor = new Date(new Date(ts).getTime() - backfillMs).toISOString();
    this.ctx.db
      .prepare(`INSERT OR IGNORE INTO tracker_sweep (id, anchor_at, swept_to, updated_at) VALUES (1, ?, NULL, ?)`)
      .run(anchor, ts);
    return this.readTrackerSweep() ?? { anchorAt: anchor, sweptTo: null, restatedAt: null };
  }

  readTrackerSweep(): TrackerSweepMark | null {
    const row = this.ctx.db.prepare(`SELECT anchor_at, swept_to, restated_at FROM tracker_sweep WHERE id = 1`).get() as
      | { anchor_at: string; swept_to: string | null; restated_at: string | null }
      | undefined;
    return row ? { anchorAt: row.anchor_at, sweptTo: row.swept_to, restatedAt: row.restated_at } : null;
  }

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

  listTicketsClosedSince(since: string): TicketClosure[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT number, changed_at FROM tracker_items WHERE state = 'closed' AND changed_at >= ? ORDER BY number`,
      )
      .all(since) as { number: number; changed_at: string }[];
    return rows.map((r) => ({ number: r.number, closedAt: r.changed_at }));
  }

  listTrackerItems(): MirroredTicket[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM tracker_items ORDER BY number DESC`).all() as TrackerItemRow[];
    return rows.map(rowToTicket);
  }

  readTrackerItems(numbers: readonly number[]): MirroredTicket[] {
    if (numbers.length === 0) return [];
    const rows = this.ctx.db
      .prepare(`SELECT * FROM tracker_items WHERE number IN (${numbers.map(() => '?').join(',')})`)
      .all(...numbers) as TrackerItemRow[];
    return rows.map(rowToTicket);
  }

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

  patchTicketState(patch: { number: number; state: string }): void {
    this.ctx.db
      .prepare(`UPDATE tracker_items SET work_item_state = ?, updated_at = ? WHERE number = ?`)
      .run(patch.state, this.ctx.now(), patch.number);
  }

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

  listFeatureSummaries(): FeatureSummary[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM feature_summaries`).all() as FeatureSummaryRow[];
    return rows.map(rowToFeatureSummary);
  }
}

interface TicketLabelPatch {
  numbers: readonly number[];
  label: string;
  present: boolean;
}

export interface TicketClosure {
  number: number;
  closedAt: string;
}

export interface MirroredTicket extends TrackerItem {
  firstSeenAt: string;
  tracking: 'live' | 'frozen';
  issueType: string | null;
  parent?: { number: number; title: string } | null;
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
