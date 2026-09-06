import { nanoid } from 'nanoid';
import type { WorldEvent, WorldEventInput, WorldEventKind, WorldSnapshot } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class WorldStore {
  constructor(private readonly ctx: StoreContext) {}

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

  getWorldBaseline(): WorldSnapshot | null {
    const row = this.ctx.db.prepare(`SELECT world FROM world_baseline WHERE id=1`).get() as
      | { world: string }
      | undefined;
    return row ? (JSON.parse(row.world) as WorldSnapshot) : null;
  }

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
