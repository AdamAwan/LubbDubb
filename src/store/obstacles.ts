import { nanoid } from 'nanoid';
import { matchObstacle, nearMatches, resolvingKeys, type NearCandidate } from '../obstacles/match.js';
import { stateAfterSighting } from '../obstacles/lifecycle.js';
import type { GatedKey } from '../obstacles/keys.js';
import type {
  Obstacle,
  ObstacleBlock,
  ObstacleDeskReading,
  ObstacleCondition,
  ObstacleEnding,
  ObstacleKey,
  ObstacleKind,
  ObstaclePurpose,
  ObstacleSighting,
  ObstacleStanding,
  ObstacleState,
  ObstacleWriteUp,
  ObstacleWriteUpOutcome,
} from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const OBSTACLE_COLUMNS: ColumnMigrations = { obstacles: { ended_by: 'TEXT' } };

interface ObstacleReport {
  what: string;
  kind: ObstacleKind;
  keys: readonly GatedKey[];
  untilHours: number | null;
}

interface ObstacleObserver {
  agentId: string | null;
  taskId: string | null;
  goalRef: string | null;
  sessionId: string | null;
  transition: string | null;
  words: string;
  whyNotMine: string | null;
}

interface ObstacleOutcome {
  obstacle: Obstacle;
  filed: boolean;
  voices: number;
  matchedBy: string;
  sightingId: string;
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
  ended_by: string | null;
}

interface ConditionRow {
  id: string;
  obstacle_id: string;
  kind: string;
  check_name: string;
  branch: string;
  met_at: string | null;
  created_at: string;
}

interface WriteUpRow {
  obstacle_id: string;
  job_id: string;
  pr_ref: string | null;
  outcome: string | null;
  created_at: string;
  settled_at: string | null;
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

interface ReadingRow {
  obstacle_id: string;
  read_at: string;
  taken_at: string;
  purpose: string | null;
  title: string | null;
  body: string | null;
}

interface BlockRow {
  origin_ref: string;
  obstacle_id: string;
  agent_id: string | null;
  task_id: string | null;
  note: string;
  created_at: string;
}

export class ObstacleStore {
  constructor(private readonly ctx: StoreContext) {}

  recordObstacleSighting(report: ObstacleReport, observer: ObstacleObserver): ObstacleOutcome {
    return this.ctx.db.transaction((): ObstacleOutcome => {
      const at = this.ctx.now();
      const lookup = (value: string): string | null => this.obstacleIdForKey(value);
      const matched = matchObstacle(report.keys, lookup);
      const existing = matched === null ? null : this.getObstacle(matched.obstacleId);
      const filed = existing === null;
      const obstacle = existing ?? this.insertObstacle(report, at);
      const winner = this.attachKeys(obstacle.id, report.keys, at);
      const home = winner === obstacle.id ? obstacle : (this.getObstacle(winner) ?? obstacle);
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
        near: [
          ...(matched !== null
            ? []
            : nearMatches({
                what: report.what,
                keys: report.keys,
                rows: this.listObstacles().map((o) => ({ id: o.id, what: o.what })),
                lookup,
                exclude: home.id,
              })),
          ...this.listObstacleSuggestions(home.id),
        ],
      };
    })();
  }

  claimObstacleNotice(obstacleId: string, agentId: string, reason: string): boolean {
    const result = this.ctx.db
      .prepare(`INSERT OR IGNORE INTO obstacle_notices (obstacle_id, agent_id, reason, created_at) VALUES (?,?,?,?)`)
      .run(obstacleId, agentId, reason, this.ctx.now());
    return result.changes > 0;
  }

  obstaclesNoticedBy(agentId: string): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT obstacle_id FROM obstacle_notices WHERE agent_id=?`).all(agentId) as {
      obstacle_id: string;
    }[];
    return new Set(rows.map((row) => row.obstacle_id));
  }

  obstacleNoticesSent(): number {
    const row = this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM obstacle_notices`).get() as { n: number };
    return row.n;
  }

  claimObstacle(id: string): boolean {
    const at = this.ctx.now();
    const result = this.ctx.db
      .prepare(
        `UPDATE obstacles SET state='owned', updated_at=?
           WHERE id=? AND state='standing' AND owner_ref IS NULL`,
      )
      .run(at, id);
    return result.changes > 0;
  }

  setObstacleOwner(id: string, ownerRef: string): void {
    this.ctx.db
      .prepare(`UPDATE obstacles SET owner_ref=?, updated_at=? WHERE id=? AND state='owned'`)
      .run(ownerRef, this.ctx.now(), id);
  }

  releaseObstacle(id: string): void {
    this.ctx.db
      .prepare(`UPDATE obstacles SET state='standing', updated_at=? WHERE id=? AND state='owned' AND owner_ref IS NULL`)
      .run(this.ctx.now(), id);
  }

  recordObstacleBlock(input: {
    originRef: string;
    obstacleId: string;
    agentId: string | null;
    taskId: string | null;
    note: string;
  }): ObstacleBlock {
    const at = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO obstacle_blocks (origin_ref, obstacle_id, agent_id, task_id, note, created_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(origin_ref) DO UPDATE SET
           obstacle_id=excluded.obstacle_id, agent_id=excluded.agent_id,
           task_id=excluded.task_id, note=excluded.note, created_at=excluded.created_at`,
      )
      .run(input.originRef, input.obstacleId, input.agentId, input.taskId, input.note, at);
    return { ...input, createdAt: at };
  }

  listObstacleBlocks(): ObstacleBlock[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_blocks ORDER BY created_at ASC, rowid ASC`)
      .all() as BlockRow[];
    return rows.map((row) => ({
      originRef: row.origin_ref,
      obstacleId: row.obstacle_id,
      agentId: row.agent_id,
      taskId: row.task_id,
      note: row.note,
      createdAt: row.created_at,
    }));
  }

  endObstacle(id: string, state: 'resolved' | 'dormant', endedBy: ObstacleEnding): boolean {
    const result = this.ctx.db
      .prepare(
        `UPDATE obstacles SET state=?, ended_by=?, updated_at=?
           WHERE id=? AND state IN ('sighted','standing','owned')`,
      )
      .run(state, endedBy, this.ctx.now(), id);
    return result.changes > 0;
  }

  muteObstacle(id: string, muted: boolean): boolean {
    const at = this.ctx.now();
    const result = muted
      ? this.ctx.db
          .prepare(
            `UPDATE obstacles SET state='muted', ended_by=NULL, updated_at=?
               WHERE id=? AND state IN ('sighted','standing','owned')`,
          )
          .run(at, id)
      : this.ctx.db
          .prepare(`UPDATE obstacles SET state='standing', ended_by=NULL, updated_at=? WHERE id=? AND state='muted'`)
          .run(at, id);
    return result.changes > 0;
  }

  watchObstacleCondition(input: { obstacleId: string; kind: 'check-green'; checkName: string; branch: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO obstacle_conditions (id, obstacle_id, kind, check_name, branch, met_at, created_at)
         VALUES (?,?,?,?,?,NULL,?)`,
      )
      .run(`obc-${nanoid(8)}`, input.obstacleId, input.kind, input.checkName, input.branch, this.ctx.now());
  }

  listObstacleConditions(obstacleId: string): ObstacleCondition[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_conditions WHERE obstacle_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(obstacleId) as ConditionRow[];
    return rows.map(toCondition);
  }

  setObstacleConditionMet(id: string, met: boolean): void {
    if (!met) {
      this.ctx.db.prepare(`UPDATE obstacle_conditions SET met_at=NULL WHERE id=? AND met_at IS NOT NULL`).run(id);
      return;
    }
    this.ctx.db
      .prepare(`UPDATE obstacle_conditions SET met_at=? WHERE id=? AND met_at IS NULL`)
      .run(this.ctx.now(), id);
  }

  recordObstacleWriteUp(obstacleId: string, jobId: string): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO obstacle_writeups (obstacle_id, job_id, pr_ref, outcome, created_at, settled_at)
         VALUES (?,?,NULL,NULL,?,NULL)`,
      )
      .run(obstacleId, jobId, this.ctx.now());
  }

  obstaclesWrittenUp(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT obstacle_id FROM obstacle_writeups`).all() as { obstacle_id: string }[];
    return new Set(rows.map((row) => row.obstacle_id));
  }

  openObstacleWriteUps(): ObstacleWriteUp[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_writeups WHERE outcome IS NULL ORDER BY created_at ASC`)
      .all() as WriteUpRow[];
    return rows.map(toWriteUp);
  }

  noteObstacleWriteUpPr(obstacleId: string, prRef: string): void {
    this.ctx.db
      .prepare(`UPDATE obstacle_writeups SET pr_ref=? WHERE obstacle_id=? AND pr_ref IS NULL AND outcome IS NULL`)
      .run(prRef, obstacleId);
  }

  settleObstacleWriteUp(obstacleId: string, outcome: ObstacleWriteUpOutcome): boolean {
    const result = this.ctx.db
      .prepare(`UPDATE obstacle_writeups SET outcome=?, settled_at=? WHERE obstacle_id=? AND outcome IS NULL`)
      .run(outcome, this.ctx.now(), obstacleId);
    return result.changes > 0;
  }

  clearObstacleBlock(originRef: string): void {
    this.ctx.db.prepare(`DELETE FROM obstacle_blocks WHERE origin_ref=?`).run(originRef);
  }

  obstacleInbox(): ObstacleStanding[] {
    const read = new Map(
      (this.ctx.db.prepare(`SELECT obstacle_id, read_at FROM obstacle_readings`).all() as ReadingRow[]).map((row) => [
        row.obstacle_id,
        row.read_at,
      ]),
    );
    const spoken = new Set(
      (
        this.ctx.db.prepare(`SELECT DISTINCT obstacle_id FROM obstacle_sightings WHERE transition IS NULL`).all() as {
          obstacle_id: string;
        }[]
      ).map((row) => row.obstacle_id),
    );
    return this.obstacleBoard().filter(
      ({ obstacle }) =>
        (obstacle.state === 'sighted' || obstacle.state === 'standing') &&
        spoken.has(obstacle.id) &&
        read.get(obstacle.id) !== obstacle.lastSeenAt,
    );
  }

  obstacleReading(obstacleId: string): ObstacleDeskReading | null {
    const row = this.ctx.db.prepare(`SELECT * FROM obstacle_readings WHERE obstacle_id=?`).get(obstacleId) as
      | ReadingRow
      | undefined;
    return row ? toReading(row) : null;
  }

  recordObstacleReading(input: {
    obstacleId: string;
    readAt: string;
    purpose: ObstaclePurpose | null;
    title: string | null;
    body: string | null;
  }): void {
    this.ctx.db
      .prepare(
        `INSERT INTO obstacle_readings (obstacle_id, read_at, taken_at, purpose, title, body)
           VALUES (?,?,?,?,?,?)
         ON CONFLICT(obstacle_id) DO UPDATE SET
           read_at=excluded.read_at, taken_at=excluded.taken_at,
           purpose=excluded.purpose, title=excluded.title, body=excluded.body`,
      )
      .run(input.obstacleId, input.readAt, this.ctx.now(), input.purpose, input.title, input.body);
  }

  addObstacleKeys(obstacleId: string, keys: readonly GatedKey[]): { added: number; taken: string[] } {
    return this.ctx.db.transaction((): { added: number; taken: string[] } => {
      const at = this.ctx.now();
      const insert = this.ctx.db.prepare(
        `INSERT OR IGNORE INTO obstacle_keys (id, obstacle_id, kind, value, binds, confirmations, created_at)
         VALUES (?,?,?,?,?,0,?)`,
      );
      let added = 0;
      const taken: string[] = [];
      for (const key of keys) {
        const owner = this.obstacleIdForKey(key.value);
        if (owner === obstacleId) continue;
        if (owner !== null) {
          taken.push(owner);
          continue;
        }
        insert.run(`obk-${nanoid(8)}`, obstacleId, key.kind, key.value, key.binds ? 1 : 0, at);
        added += 1;
      }
      return { added, taken: [...new Set(taken)] };
    })();
  }

  suggestObstacleMerge(obstacleId: string, suggestedId: string, source: 'model' | 'key'): void {
    if (obstacleId === suggestedId) return;
    if (this.getObstacle(suggestedId) === null) return;
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO obstacle_suggestions (obstacle_id, suggested_id, source, created_at) VALUES (?,?,?,?)`,
      )
      .run(obstacleId, suggestedId, source, this.ctx.now());
  }

  listObstacleSuggestions(obstacleId: string): NearCandidate[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT o.id AS id, o.what AS what FROM obstacle_suggestions s
           JOIN obstacles o ON o.id = CASE WHEN s.obstacle_id=? THEN s.suggested_id ELSE s.obstacle_id END
         WHERE s.obstacle_id=? OR s.suggested_id=?
         ORDER BY s.created_at ASC`,
      )
      .all(obstacleId, obstacleId, obstacleId) as NearCandidate[];
    return rows;
  }

  setObstacleKind(id: string, kind: ObstacleKind): boolean {
    const result = this.ctx.db
      .prepare(
        `UPDATE obstacles SET kind=?, updated_at=?
           WHERE id=? AND kind<>? AND owner_ref IS NULL AND state IN ('sighted','standing')
             AND NOT EXISTS (SELECT 1 FROM obstacle_writeups WHERE obstacle_id=?)`,
      )
      .run(kind, this.ctx.now(), id, kind, id);
    return result.changes > 0;
  }

  obstacleBoard(): ObstacleStanding[] {
    return this.listObstacles().map((obstacle) => {
      const sightings = this.listObstacleSightings(obstacle.id);
      return {
        obstacle,
        keys: this.listObstacleKeys(obstacle.id),
        voices: this.obstacleVoices(obstacle.id),
        goalRefs: [...new Set(sightings.map((s) => s.goalRef).filter((ref): ref is string => ref !== null))],
        words: sightings.map((s) => s.words),
      };
    });
  }

  getObstacle(id: string): Obstacle | null {
    const row = this.ctx.db.prepare(`SELECT * FROM obstacles WHERE id=?`).get(id) as ObstacleRow | undefined;
    return row ? toObstacle(row) : null;
  }

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

  listObstacleSightings(obstacleId: string): ObstacleSighting[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_sightings WHERE obstacle_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(obstacleId) as SightingRow[];
    return rows.map(toSighting);
  }

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
      state: 'sighted',
      ownerRef: null,
      until: report.untilHours === null ? null : new Date(Date.parse(at) + report.untilHours * 3_600_000).toISOString(),
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
      endedBy: null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO obstacles (id, what, kind, state, owner_ref, until, created_at, updated_at, last_seen_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(obstacle.id, obstacle.what, obstacle.kind, obstacle.state, obstacle.ownerRef, obstacle.until, at, at, at);
    return obstacle;
  }

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

  private setState(obstacle: Obstacle, state: ObstacleState, at: string): Obstacle {
    this.ctx.db
      .prepare(`UPDATE obstacles SET state=?, ended_by=NULL, updated_at=?, last_seen_at=? WHERE id=?`)
      .run(state, at, at, obstacle.id);
    return { ...obstacle, state, endedBy: null, updatedAt: at, lastSeenAt: at };
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
    endedBy: (row.ended_by as ObstacleEnding | null) ?? null,
  };
}

function toReading(row: ReadingRow): ObstacleDeskReading {
  return {
    obstacleId: row.obstacle_id,
    readAt: row.read_at,
    takenAt: row.taken_at,
    purpose: (row.purpose as ObstaclePurpose | null) ?? null,
    title: row.title,
    body: row.body,
  };
}

function toCondition(row: ConditionRow): ObstacleCondition {
  return {
    id: row.id,
    obstacleId: row.obstacle_id,
    kind: row.kind as ObstacleCondition['kind'],
    checkName: row.check_name,
    branch: row.branch,
    metAt: row.met_at,
    createdAt: row.created_at,
  };
}

function toWriteUp(row: WriteUpRow): ObstacleWriteUp {
  return {
    obstacleId: row.obstacle_id,
    jobId: row.job_id,
    prRef: row.pr_ref,
    outcome: (row.outcome as ObstacleWriteUpOutcome | null) ?? null,
    createdAt: row.created_at,
    settledAt: row.settled_at,
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
