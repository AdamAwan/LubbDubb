import { nanoid } from 'nanoid';
import type { WorldEvent, WorldEventInput, WorldEventKind, WorldSnapshot } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * What the pulse writes about the outside world: `world_events` (each diffed
 * transition), `world_baseline` (the snapshot the next diff is taken against, and
 * what `world_read` serves an agent) and `connector_state` (whatever a provider
 * needs to remember between cycles).
 */
export class WorldStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Stamp each diffed transition with an id + timestamp, persist, return rows. */
  recordWorldEvents(inputs: WorldEventInput[]): WorldEvent[] {
    const at = this.ctx.now();
    const stmt = this.ctx.db.prepare(
      `INSERT INTO world_events (id, kind, ref, summary, created_at) VALUES (@id, @kind, @ref, @summary, @createdAt)`,
    );
    const events = inputs.map((input) => ({ id: `we_${nanoid(10)}`, createdAt: at, ...input }));
    const insertAll = this.ctx.db.transaction((rows: WorldEvent[]) => {
      for (const row of rows) stmt.run(row);
    });
    insertAll(events);
    return events;
  }

  listWorldEvents(limit = 200): WorldEvent[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM world_events ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as WorldEventRow[];
    return rows.map(rowToWorldEvent);
  }

  /**
   * Transitions observed for `refs` strictly after `since` — "has anything
   * happened to these items since then", which is what ends a rejection's
   * standing (issue #109 phase 4, `rejectionSignalQuery`).
   *
   * Bounded by time and item rather than by row count, unlike {@link
   * listWorldEvents}, whose limit serves a feed that only has to be long enough
   * to read. A rejection is unbounded in age, so a count-bounded read would judge
   * an old one against events it cannot see; naming the window removes the case
   * instead of answering it, and keeps the read small — it is the handful of
   * items actually carrying a rejection, over the `world_events(created_at)`
   * index. No refs, no query.
   */
  listWorldEventsSince(since: string, refs: string[]): WorldEvent[] {
    if (refs.length === 0) return [];
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM world_events WHERE created_at > ? AND ref IN (${refs.map(() => '?').join(',')})
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(since, ...refs) as WorldEventRow[];
    return rows.map(rowToWorldEvent);
  }

  /**
   * Every event of these kinds since `since`, **oldest first**.
   *
   * The ascending order is the difference from its two neighbours and it is the
   * point: this read serves a fold over each ref's transitions in the order they
   * happened — a pull request is red *until* the next green, and a span read
   * backwards is a span read wrong. Bounded by kind as well as time because the
   * caller wants one conversation out of a feed that carries eight.
   */
  listWorldEventsOfKindsSince(since: string, kinds: readonly WorldEventKind[]): WorldEvent[] {
    if (kinds.length === 0) return [];
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM world_events WHERE created_at > ? AND kind IN (${kinds.map(() => '?').join(',')})
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(since, ...kinds) as WorldEventRow[];
    return rows.map(rowToWorldEvent);
  }

  /** The last snapshot the harness diffed against, or null on a fresh store. */
  getWorldBaseline(): WorldSnapshot | null {
    const row = this.ctx.db.prepare(`SELECT world FROM world_baseline WHERE id=1`).get() as
      | { world: string }
      | undefined;
    return row ? (JSON.parse(row.world) as WorldSnapshot) : null;
  }

  /**
   * Write a label the provider has just accepted onto the stored baseline.
   *
   * `/api/state` serves the baseline and never a live provider read (16), so
   * until this runs a tag the operator has just set is invisible — the cockpit
   * redraws the item exactly as it was. The pulse cannot be what makes it
   * visible: `runCycle` coalesces while a cycle is in flight, so the click that
   * lands during one is followed by no world read at all, and the toggle stays
   * on its old state until the next beat.
   *
   * Only ever called for a write the provider confirmed, so this is observed
   * fact arriving early rather than a guess: the next cycle reads the same tag
   * back off the tracker and writes the same baseline. An item the baseline does
   * not carry is skipped — the world it came from has aged out, and inventing a
   * row for it would put an issue in the cockpit that no snapshot described.
   *
   * An **empty** label is a no-op, not an empty string written onto every named
   * item: that is `labelPrefix: ''`, the gate switched off, where every item
   * already reads as watched and there is no tag to show.
   */
  patchWorldLabels(patch: WorldLabelPatch): void {
    const world = this.getWorldBaseline();
    if (world === null || patch.label === '') return;
    const issues = new Set(patch.issues ?? []);
    const prs = new Set(patch.pullRequests ?? []);
    let touched = false;
    const apply = (labels: string[] | undefined): string[] => {
      const next = new Set(labels ?? []);
      if (patch.present) next.add(patch.label);
      else next.delete(patch.label);
      return [...next];
    };
    for (const issue of world.issues) {
      if (!issues.has(issue.number)) continue;
      issue.labels = apply(issue.labels);
      // The ownership view of the same tag: with `issuePickupRequireOwnLabel` on
      // this is what pickup reads, and a baseline where the two disagree is one
      // where the cockpit says "Watching" and nothing is ever picked up. The
      // operator did add it, so the viewer did.
      if (issue.labelsAddedByViewer !== undefined) issue.labelsAddedByViewer = apply(issue.labelsAddedByViewer);
      touched = true;
    }
    for (const pr of world.pullRequests) {
      if (!prs.has(pr.number)) continue;
      pr.labels = apply(pr.labels);
      touched = true;
    }
    if (touched) this.setWorldBaseline(world);
  }

  /**
   * Write a work-item state the provider has just accepted onto the stored baseline.
   *
   * {@link patchWorldLabels}' sibling, for its reasons: `/api/state` serves the
   * baseline and never a live read, and the pulse cannot be what makes the change
   * visible — `runCycle` coalesces while a cycle is in flight, so a drop that lands
   * during one is followed by no world read at all and the card snaps back to its old
   * column until the next beat.
   *
   * Only ever called for a write the provider confirmed, so this is observed fact
   * arriving early rather than a guess: the next cycle reads the same state back off
   * the tracker and writes the same baseline. An item the baseline does not carry is
   * skipped — the world it came from has aged out, and inventing a row for it would
   * put an issue in the cockpit that no snapshot described.
   */
  patchWorldState(patch: { number: number; state: string }): void {
    const world = this.getWorldBaseline();
    if (world === null) return;
    const issue = world.issues.find((i) => i.number === patch.number);
    if (issue === undefined) return;
    issue.workItemState = patch.state;
    this.setWorldBaseline(world);
  }

  setWorldBaseline(world: WorldSnapshot): void {
    this.ctx.db
      .prepare(
        `INSERT INTO world_baseline (id, world) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET world=excluded.world`,
      )
      .run(JSON.stringify(world));
  }

  // -- Connector persistence ----------------------------------------------

  getConnectorState(key: string): string | null {
    const row = this.ctx.db.prepare(`SELECT value FROM connector_state WHERE key=?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setConnectorState(key: string, value: string): void {
    this.ctx.db
      .prepare(
        `INSERT INTO connector_state (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(key, value);
  }
}

/**
 * A label change to fold onto the stored baseline: which items carry it now, and
 * whether it went on or came off. One label per call, because that is the shape
 * of every caller — a watch toggle writes one tag.
 */
export interface WorldLabelPatch {
  issues?: readonly number[];
  pullRequests?: readonly number[];
  label: string;
  present: boolean;
}

interface WorldEventRow {
  id: string;
  kind: string;
  ref: string | null;
  summary: string;
  created_at: string;
}

function rowToWorldEvent(r: WorldEventRow): WorldEvent {
  return {
    id: r.id,
    kind: r.kind as WorldEvent['kind'],
    ref: r.ref,
    summary: r.summary,
    createdAt: r.created_at,
  };
}
