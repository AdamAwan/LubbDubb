import { nanoid } from 'nanoid';
import { matchObstacle, nearMatches, resolvingKeys, type NearCandidate } from '../obstacles/match.js';
import { stateAfterSighting } from '../obstacles/lifecycle.js';
import type { GatedKey } from '../obstacles/keys.js';
import type { Obstacle, ObstacleKey, ObstacleKind, ObstacleSighting, ObstacleState } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

/**
 * The obstacle board: `obstacles`, `obstacle_keys`, `obstacle_sightings`.
 *
 * **The uniqueness constraint is on a key's `value`, and not on `(kind, value)`.**
 * The value is the identity; the kind is a column beside it. Two agents may
 * reasonably disagree about whether something is a flaking test or a broken check,
 * and if the kind were part of the index that disagreement would split one obstacle
 * into two — the prose problem this store replaces, rebuilt with a smaller
 * vocabulary. `check:test (windows)` and `test:test (windows)` are one key.
 *
 * **The claim is made inside the synchronous write** `CLAUDE.md` already
 * guarantees: insert the keys, read back which obstacle won, attach the loser's
 * report to the winner. Two agents reporting in the same millisecond cannot both
 * create a row, and neither waits.
 *
 * The three tables are new, so they need no {@link OBSTACLE_COLUMNS} entries — and
 * being new *once* is what stops that keeping them exempt: the first column added
 * to any of them later belongs there. → `docs/spec/32-obstacles.md`
 */
export const OBSTACLE_COLUMNS: ColumnMigrations = {};

/** What one report says, before any of it has been matched. */
interface ObstacleReport {
  /** One line, the reporter's own words with its own frame already stripped. */
  what: string;
  /** Whether a fix would make it go away. */
  kind: ObstacleKind;
  /** The keys, through all three gates. */
  keys: readonly GatedKey[];
  /**
   * The reporter's clock in hours, read only by the backstop. Null for most
   * reports, and resolved to an instant here rather than at the boundary so the
   * store's own clock is what stamps it.
   */
  untilHours: number | null;
}

/** Who is reporting, as the voice count reads them. */
interface ObstacleObserver {
  agentId: string | null;
  taskId: string | null;
  /** The goal, collapsed from the origin — never the origin, and never the agent. */
  goalRef: string | null;
  sessionId: string | null;
  /** What the harness saw, for its own voice. Null for an agent's. */
  transition: string | null;
  /** The reporter's own sentence, verbatim. */
  words: string;
  /** Required at the intake; nothing reads it but an operator. */
  whyNotMine: string | null;
}

/** What one report is answered with. */
export interface ObstacleOutcome {
  obstacle: Obstacle;
  /** Whether this report created the row. */
  filed: boolean;
  /** How many independent voices have now said it. */
  voices: number;
  /** Why it landed here: the key that bound it, or `fresh`. */
  matchedBy: string;
  /** The sighting this call wrote, which is never one of the *others* it is answered with. */
  sightingId: string;
  /** Rows a suggestion linked but no key merged, so the reporter may agree by id. */
  near: NearCandidate[];
}

interface ObstacleRow {
  id: string;
  what: string;
  kind: string;
  state: string;
  owner_ref: string | null;
  until: string | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}

interface KeyRow {
  id: string;
  obstacle_id: string;
  kind: string;
  value: string;
  binds: number;
  confirmations: number;
  created_at: string;
}

interface SightingRow {
  id: string;
  obstacle_id: string;
  agent_id: string | null;
  task_id: string | null;
  goal_ref: string | null;
  session_id: string | null;
  transition: string | null;
  words: string;
  why_not_mine: string | null;
  matched_by: string;
  created_at: string;
}

export class ObstacleStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * File a report, or record that somebody else has now seen what is already on
   * the board.
   *
   * One entry point for both because they are one act from the reporter's side: an
   * agent in pain calls the tool, and whether anybody else has hit the same thing
   * is exactly what it cannot know. **The report is filed either way** and never
   * held pending anything — a round trip is a report that may never come back.
   *
   * Everything below happens in one transaction, which is what makes the race
   * unreachable rather than unlikely.
   */
  recordObstacleSighting(report: ObstacleReport, observer: ObstacleObserver): ObstacleOutcome {
    return this.ctx.db.transaction((): ObstacleOutcome => {
      const at = this.ctx.now();
      const lookup = (value: string): string | null => this.obstacleIdForKey(value);
      const matched = matchObstacle(report.keys, lookup);
      const existing = matched === null ? null : this.getObstacle(matched.obstacleId);
      // A key naming a row that is gone is a key nothing owns: file fresh rather
      // than attach a sighting to an id no reader can resolve.
      const filed = existing === null;
      const obstacle = existing ?? this.insertObstacle(report, at);
      // Insert the keys *after* the row exists, and read back which obstacle each
      // value actually landed on: a value another report claimed first stays that
      // report's, and this one's sighting follows it there.
      const winner = this.attachKeys(obstacle.id, report.keys, at);
      const home = winner === obstacle.id ? obstacle : (this.getObstacle(winner) ?? obstacle);
      // The loser's report goes to the winner — its keys included, so the row that
      // stood carries every way into the thing rather than only the first one
      // anybody used.
      if (home.id !== obstacle.id) this.foldInto(obstacle.id, home.id);
      const sightingId = this.insertSighting(home.id, observer, matched?.matchedBy ?? 'fresh', at);
      const voices = this.obstacleVoices(home.id);
      const state = stateAfterSighting(home.state, voices);
      const moved = this.setState(home, state, at);
      return {
        obstacle: moved,
        filed: filed && home.id === obstacle.id,
        voices,
        matchedBy: matched?.matchedBy ?? 'fresh',
        sightingId,
        // Only where nothing bound. A report that joined a row has already found
        // the one it meant, and offering it neighbours would be inviting a second
        // guess at a question the keys answered.
        near:
          matched !== null
            ? []
            : nearMatches({
                what: report.what,
                keys: report.keys,
                rows: this.listObstacles().map((o) => ({ id: o.id, what: o.what })),
                lookup,
                exclude: home.id,
              }),
      };
    })();
  }

  getObstacle(id: string): Obstacle | null {
    const row = this.ctx.db.prepare(`SELECT * FROM obstacles WHERE id=?`).get(id) as ObstacleRow | undefined;
    return row ? toObstacle(row) : null;
  }

  /** Every row, newest sighting first — which is the order the board is read in. */
  listObstacles(): Obstacle[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacles ORDER BY last_seen_at DESC, rowid DESC`)
      .all() as ObstacleRow[];
    return rows.map(toObstacle);
  }

  listObstacleKeys(obstacleId: string): ObstacleKey[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_keys WHERE obstacle_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(obstacleId) as KeyRow[];
    return rows.map(toKey);
  }

  /** The voices behind one row, oldest first — which is the order they are shown in. */
  listObstacleSightings(obstacleId: string): ObstacleSighting[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_sightings WHERE obstacle_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(obstacleId) as SightingRow[];
    return rows.map(toSighting);
  }

  /**
   * How many **independent** voices have said it.
   *
   * A voice is a goal, or the harness — and a goal is counted as a goal, never as
   * an origin and never as an agent. One goal saying a thing twice is one voice;
   * the harness observing the same transition on ten pulses is one voice, because
   * the transition is the identity. A sighting with neither a goal nor a transition
   * behind it counts as itself, which is the honest answer: nothing about it can be
   * shown to be an echo of anything else.
   *
   * Sessions fold too: a re-dispatch inherits the conversation through `spawn`'s
   * `resumeSessionId`, so an agent corroborating its own predecessor arrives
   * carrying its session id.
   */
  obstacleVoices(obstacleId: string): number {
    const rows = this.listObstacleSightings(obstacleId);
    const parent = new Map<string, string>();
    const find = (key: string): string => {
      let root = parent.get(key) ?? key;
      while (root !== (parent.get(root) ?? root)) root = parent.get(root)!;
      parent.set(key, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      const [ra, rb] = [find(a), find(b)];
      if (ra !== rb) parent.set(ra, rb);
    };
    const keys = rows.map((row) =>
      row.transition ? `transition:${row.transition}` : row.goalRef ? `goal:${row.goalRef}` : `row:${row.id}`,
    );
    for (const [i, row] of rows.entries()) {
      const key = keys[i]!;
      if (!parent.has(key)) parent.set(key, key);
      if (row.sessionId) union(key, `session:${row.sessionId}`);
    }
    return new Set(keys.map(find)).size;
  }

  private insertObstacle(report: ObstacleReport, at: string): Obstacle {
    const obstacle: Obstacle = {
      id: `obs-${nanoid(8)}`,
      what: report.what,
      kind: report.kind,
      // Never anything else on a first report. **One report is not evidence**, and
      // it is the case the harness cannot tell apart from an agent mis-diagnosing
      // its own breakage.
      state: 'sighted',
      ownerRef: null,
      until: report.untilHours === null ? null : new Date(Date.parse(at) + report.untilHours * 3_600_000).toISOString(),
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO obstacles (id, what, kind, state, owner_ref, until, created_at, updated_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(obstacle.id, obstacle.what, obstacle.kind, obstacle.state, obstacle.ownerRef, obstacle.until, at, at, at);
    return obstacle;
  }

  /**
   * Insert this report's keys and answer which obstacle actually holds them.
   *
   * `INSERT OR IGNORE` against the UNIQUE on `value`, then a read back: a value
   * another row already owns stays that row's, and the caller follows its sighting
   * there rather than writing a second copy of one obstacle. A key that only ever
   * suggests is attached exactly the same way — it is on the row and in the answer;
   * what it does not do is resolve one.
   */
  private attachKeys(obstacleId: string, keys: readonly GatedKey[], at: string): string {
    const movable = new Set(resolvingKeys(keys).map((key) => key.value));
    const insert = this.ctx.db.prepare(
      `INSERT OR IGNORE INTO obstacle_keys (id, obstacle_id, kind, value, binds, confirmations, created_at)
       VALUES (?,?,?,?,?,0,?)`,
    );
    let home = obstacleId;
    for (const key of keys) {
      insert.run(`obk-${nanoid(8)}`, obstacleId, key.kind, key.value, key.binds ? 1 : 0, at);
      const owner = this.obstacleIdForKey(key.value);
      // Only a *binding* key may move the report: a signature the board already
      // holds is a suggestion, and following it would be a model's merge wearing a
      // key's clothes.
      if (owner !== null && owner !== obstacleId && movable.has(key.value) && home === obstacleId) home = owner;
    }
    return home;
  }

  private obstacleIdForKey(value: string): string | null {
    const row = this.ctx.db.prepare(`SELECT obstacle_id FROM obstacle_keys WHERE value=?`).get(value) as
      | { obstacle_id: string }
      | undefined;
    return row?.obstacle_id ?? null;
  }

  /**
   * Hand one row's keys to another and drop the empty one.
   *
   * Reachable only for a row this same call created a moment ago, which is why
   * nothing is merged and nothing is lost: a row with sightings on it has been
   * *told to somebody*, and folding one of those would be exactly the invisible
   * merge no model is allowed to make either.
   */
  private foldInto(from: string, to: string): void {
    this.ctx.db.prepare(`UPDATE obstacle_keys SET obstacle_id=? WHERE obstacle_id=?`).run(to, from);
    this.ctx.db
      .prepare(
        `DELETE FROM obstacles WHERE id=? AND NOT EXISTS
       (SELECT 1 FROM obstacle_sightings WHERE obstacle_id=?)`,
      )
      .run(from, from);
  }

  private insertSighting(obstacleId: string, observer: ObstacleObserver, matchedBy: string, at: string): string {
    const statement = this.ctx.db.prepare(
      `INSERT INTO obstacle_sightings
           (id, obstacle_id, agent_id, task_id, goal_ref, session_id, transition, words, why_not_mine, matched_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const id = `obs-s-${nanoid(8)}`;
    statement.run(
      id,
      obstacleId,
      observer.agentId,
      observer.taskId,
      observer.goalRef,
      observer.sessionId,
      observer.transition,
      observer.words,
      observer.whyNotMine,
      matchedBy,
      at,
    );
    return id;
  }

  /**
   * Move a row, and stamp when it was last seen either way.
   *
   * `last_seen_at` moves on every sighting even where the state does not, because
   * decay reads it: a row re-reported daily and never promoted is not dormant, and
   * a row whose state is unchanged is not a row nothing has said.
   */
  private setState(obstacle: Obstacle, state: ObstacleState, at: string): Obstacle {
    this.ctx.db
      .prepare(`UPDATE obstacles SET state=?, updated_at=?, last_seen_at=? WHERE id=?`)
      .run(state, at, at, obstacle.id);
    return { ...obstacle, state, updatedAt: at, lastSeenAt: at };
  }
}

function toObstacle(row: ObstacleRow): Obstacle {
  return {
    id: row.id,
    what: row.what,
    kind: row.kind as ObstacleKind,
    state: row.state as ObstacleState,
    ownerRef: row.owner_ref,
    until: row.until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function toKey(row: KeyRow): ObstacleKey {
  return {
    id: row.id,
    obstacleId: row.obstacle_id,
    kind: row.kind as ObstacleKey['kind'],
    value: row.value,
    binds: row.binds === 1,
    confirmations: row.confirmations,
    createdAt: row.created_at,
  };
}

function toSighting(row: SightingRow): ObstacleSighting {
  return {
    id: row.id,
    obstacleId: row.obstacle_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    goalRef: row.goal_ref,
    sessionId: row.session_id,
    transition: row.transition,
    words: row.words,
    whyNotMine: row.why_not_mine,
    matchedBy: row.matched_by,
    createdAt: row.created_at,
  };
}
