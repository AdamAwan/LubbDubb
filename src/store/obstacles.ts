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

/**
 * The obstacle board: `obstacles`, `obstacle_keys`, `obstacle_sightings`, the
 * ledger of who has been told what, `obstacle_notices`, and the goals parked
 * behind a row, `obstacle_blocks`.
 *
 * **The uniqueness constraint is on a key's `value`, never on `(kind, value)`** —
 * the value is the identity, so `check:test (windows)` and `test:test (windows)`
 * are one key and a disagreement about kind cannot split one obstacle into two.
 * **The claim is made inside the synchronous write**: insert the keys, read back
 * which obstacle won, attach the loser's report to the winner.
 *
 * The tables were new once, and being new *once* is what stops that keeping them
 * exempt: `obstacles.ended_by` is the first column added to one of them after the
 * fact, so it is declared below. → `docs/spec/27-obstacles.md`
 *
 * **It needs no backfill, and that is a reading rather than an omission.** A null
 * `ended_by` means *this row has not ended*, which is true of every row in every
 * database that predates the column: nothing could write `resolved` or `dormant`
 * before the endings existed, so there is no row whose null is standing in for an
 * ending nobody recorded. → CLAUDE.md, "when a null means something"
 */
export const OBSTACLE_COLUMNS: ColumnMigrations = { obstacles: { ended_by: 'TEXT' } };

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

  /**
   * File a report, or record that somebody else has now seen what is already on the
   * board — one entry point, because from the reporter's side it is one act.
   * **The report is filed either way**, never held pending anything. All of it is
   * one transaction, which makes the race unreachable rather than unlikely.
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
      // Keys after the row exists, then read back where each value landed: a value
      // another report claimed first stays that report's, and this sighting follows it.
      const winner = this.attachKeys(obstacle.id, report.keys, at);
      const home = winner === obstacle.id ? obstacle : (this.getObstacle(winner) ?? obstacle);
      // The loser's report goes to the winner, keys included, so the row that stood
      // carries every way into the thing.
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
        // Only where nothing bound: a report that joined a row already found the one
        // it meant.
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
          // Suggestions standing on the row this landed on, answered whether or not a
          // key bound: an agent's answer is the only place one is offered for
          // confirmation. Still only a suggestion, confirmed by id.
          ...this.listObstacleSuggestions(home.id),
        ],
      };
    })();
  }

  /**
   * Claim the one notice this agent may ever be sent about this obstacle, and say
   * whether the claim was won. **The claim comes before the message, never after**:
   * written after a send, a crash between the two resends it, and a notice arriving
   * twice reads as a second problem. The primary key makes the claim unwinnable
   * twice. → `docs/spec/27-obstacles.md#delivery`
   */
  claimObstacleNotice(obstacleId: string, agentId: string, reason: string): boolean {
    const result = this.ctx.db
      .prepare(`INSERT OR IGNORE INTO obstacle_notices (obstacle_id, agent_id, reason, created_at) VALUES (?,?,?,?)`)
      .run(obstacleId, agentId, reason, this.ctx.now());
    return result.changes > 0;
  }

  /** Every obstacle this agent has already been told about. */
  obstaclesNoticedBy(agentId: string): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT obstacle_id FROM obstacle_notices WHERE agent_id=?`).all(agentId) as {
      obstacle_id: string;
    }[];
    return new Set(rows.map((row) => row.obstacle_id));
  }

  /**
   * How many notices have gone out, over the whole board and all time — the one
   * *told* this subsystem records. Dispatch-time delivery
   * (`src/obstacles/delivery.ts`) writes nothing, so the two must never be summed.
   * → `docs/spec/27-obstacles.md#in-the-cockpit`
   */
  obstacleNoticesSent(): number {
    const row = this.ctx.db.prepare(`SELECT COUNT(*) AS n FROM obstacle_notices`).get() as { n: number };
    return row.n;
  }

  /**
   * Take a standing row for the harness, or say it was already taken. **The claim is
   * the transition, made transactionally on `owner IS NULL`**, so two desks on one
   * pulse cannot both win it; nothing an agent calls reaches this.
   *
   * It moves the row to `owned` **before** the owner exists, so the round trip that
   * files the ticket cannot produce a second one. The window closes from the other
   * end: an `owned` row with no owner is released by {@link releaseObstacle} at the
   * top of the next pass. → `docs/spec/27-obstacles.md#ownership`
   */
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

  /** Name what is fixing it — a ticket ref, or the repair dispatch's own origin. */
  setObstacleOwner(id: string, ownerRef: string): void {
    this.ctx.db
      .prepare(`UPDATE obstacles SET owner_ref=?, updated_at=? WHERE id=? AND state='owned'`)
      .run(ownerRef, this.ctx.now(), id);
  }

  /**
   * Hand a claimed row back, and only one that was never filled. Guarded on
   * `owner_ref IS NULL`, never trusted to the caller: releasing a row with an owner
   * would reopen it while an agent was on it.
   */
  releaseObstacle(id: string): void {
    this.ctx.db
      .prepare(`UPDATE obstacles SET state='standing', updated_at=? WHERE id=? AND state='owned' AND owner_ref IS NULL`)
      .run(this.ctx.now(), id);
  }

  /**
   * Park a goal behind an obstacle, replacing whatever it was parked behind. One row
   * per goal: a second would leave the desk asking which has to clear.
   */
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

  /** Every goal parked behind an obstacle right now, oldest first. */
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

  /**
   * End a row, and record which of the endings took it. Guarded on the states an
   * ending may take: **`muted` is never moved**, and a row already `resolved` or
   * `dormant` keeps the ending that first took it. `dormant` narrows further in the
   * caller's own predicate — decay is *nothing has said it*, which an owned row
   * cannot be. → `docs/spec/27-obstacles.md#how-an-obstacle-ends`
   */
  endObstacle(id: string, state: 'resolved' | 'dormant', endedBy: ObstacleEnding): boolean {
    const result = this.ctx.db
      .prepare(
        `UPDATE obstacles SET state=?, ended_by=?, updated_at=?
           WHERE id=? AND state IN ('sighted','standing','owned')`,
      )
      .run(state, endedBy, this.ctx.now(), id);
    return result.changes > 0;
  }

  /**
   * Say never tell the fleet this, or take it back — the one control on this board
   * that is a person's and only a person's, and **the one state whose exit is you**
   * (`OBSTACLE_STATES_A_PERSON_MUST_LEAVE`). Guarded on the states `OBSTACLE_EXITS`
   * declares, so it cannot become a general `setState`; un-muting lands on
   * `standing`, not `sighted`. `ended_by` is cleared with the move, for
   * {@link setState}'s reason. → `docs/spec/27-obstacles.md#states`
   */
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

  /**
   * Promise to watch one condition, or say nothing where it is already promised.
   * `INSERT OR IGNORE` against the UNIQUE on `(obstacle_id, check_name, branch)`,
   * or duplicate promises would disagree about `met_at`. Nothing an agent calls
   * reaches this.
   */
  watchObstacleCondition(input: { obstacleId: string; kind: 'check-green'; checkName: string; branch: string }): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO obstacle_conditions (id, obstacle_id, kind, check_name, branch, met_at, created_at)
         VALUES (?,?,?,?,?,NULL,?)`,
      )
      .run(`obc-${nanoid(8)}`, input.obstacleId, input.kind, input.checkName, input.branch, this.ctx.now());
  }

  /** Every condition the harness has promised to watch for one row, oldest first. */
  listObstacleConditions(obstacleId: string): ObstacleCondition[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_conditions WHERE obstacle_id=? ORDER BY created_at ASC, rowid ASC`)
      .all(obstacleId) as ConditionRow[];
    return rows.map(toCondition);
  }

  /**
   * Stamp a condition as met by *this* reading, or clear it because this reading says
   * it is not — clearing is what makes the two readings a resolution needs
   * *consecutive*. Only transitions are written, so the column says when the world
   * started agreeing rather than when it was last asked.
   */
  setObstacleConditionMet(id: string, met: boolean): void {
    if (!met) {
      this.ctx.db.prepare(`UPDATE obstacle_conditions SET met_at=NULL WHERE id=? AND met_at IS NOT NULL`).run(id);
      return;
    }
    this.ctx.db
      .prepare(`UPDATE obstacle_conditions SET met_at=? WHERE id=? AND met_at IS NULL`)
      .run(this.ctx.now(), id);
  }

  /**
   * Record the documentation job a note is being written up by. `OR IGNORE` on the
   * obstacle's primary key, so a note is written up **once, ever**: an abandoned
   * write-up leaves the note to decay rather than being re-queued every pulse.
   */
  recordObstacleWriteUp(obstacleId: string, jobId: string): void {
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO obstacle_writeups (obstacle_id, job_id, pr_ref, outcome, created_at, settled_at)
         VALUES (?,?,NULL,NULL,?,NULL)`,
      )
      .run(obstacleId, jobId, this.ctx.now());
  }

  /** Every note that has ever been written up, settled or not — what stops a second attempt. */
  obstaclesWrittenUp(): Set<string> {
    const rows = this.ctx.db.prepare(`SELECT obstacle_id FROM obstacle_writeups`).all() as { obstacle_id: string }[];
    return new Set(rows.map((row) => row.obstacle_id));
  }

  /** The write-ups the work graph can still settle — what the sweep walks. */
  openObstacleWriteUps(): ObstacleWriteUp[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM obstacle_writeups WHERE outcome IS NULL ORDER BY created_at ASC`)
      .all() as WriteUpRow[];
    return rows.map(toWriteUp);
  }

  /**
   * Stamp the pull request a write-up's job opened, once and never again — before the
   * verdict and separately from it, since a write-up that lands and one closed
   * unmerged both need the reference drawn.
   */
  noteObstacleWriteUpPr(obstacleId: string, prRef: string): void {
    this.ctx.db
      .prepare(`UPDATE obstacle_writeups SET pr_ref=? WHERE obstacle_id=? AND pr_ref IS NULL AND outcome IS NULL`)
      .run(prRef, obstacleId);
  }

  /** End a write-up. Guarded on it being open, so two passes cannot both settle one. */
  settleObstacleWriteUp(obstacleId: string, outcome: ObstacleWriteUpOutcome): boolean {
    const result = this.ctx.db
      .prepare(`UPDATE obstacle_writeups SET outcome=?, settled_at=? WHERE obstacle_id=? AND outcome IS NULL`)
      .run(outcome, this.ctx.now(), obstacleId);
    return result.changes > 0;
  }

  /** Let a goal back into pickup. The desk's whole act — nothing else is written. */
  clearObstacleBlock(originRef: string): void {
    this.ctx.db.prepare(`DELETE FROM obstacle_blocks WHERE origin_ref=?`).run(originRef);
  }

  /**
   * The rows the model desk has not read since somebody last said something about one.
   *
   * **The inbox is a comparison and never a clock**: a reading records the row's own
   * `lastSeenAt`, so a row returns exactly when a further voice lands words on it.
   * `sighted` and `standing` only, and **only a row an agent has actually spoken on**
   * — the harness's own voice is gated but never extracted.
   * → `docs/spec/27-obstacles.md#the-harness-is-a-voice`
   */
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

  /** What the desk made of one row, or null while nothing has read it. */
  obstacleReading(obstacleId: string): ObstacleDeskReading | null {
    const row = this.ctx.db.prepare(`SELECT * FROM obstacle_readings WHERE obstacle_id=?`).get(obstacleId) as
      | ReadingRow
      | undefined;
    return row ? toReading(row) : null;
  }

  /**
   * Record what the desk read, and that it has read this much of the row. Upserted
   * rather than appended — a reading restates the whole row as its sightings stand
   * now. The stamp is written even when the reading came back empty, or the row
   * would be re-read every pulse.
   */
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

  /**
   * Attach keys the desk read out of a row's own prose, and answer which of them
   * named something another row already holds. **It never merges**: a value another
   * obstacle owns is left where it is and reported back as a suggestion, since
   * deciding two reports are one obstacle is the job no model may do. The keys have
   * already been through the three gates in `src/obstacles/keys.ts`.
   */
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

  /**
   * Record that something thinks two rows are one obstacle. **A suggestion and never
   * a merge** — a wrong merge hides one agent's report inside another's, answered
   * *already owned* with nobody fixing it. Confirmed by id, or not at all.
   */
  suggestObstacleMerge(obstacleId: string, suggestedId: string, source: 'model' | 'key'): void {
    if (obstacleId === suggestedId) return;
    if (this.getObstacle(suggestedId) === null) return;
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO obstacle_suggestions (obstacle_id, suggested_id, source, created_at) VALUES (?,?,?,?)`,
      )
      .run(obstacleId, suggestedId, source, this.ctx.now());
  }

  /**
   * The rows suggested as this one, from **either** end of the pair — the pair is one
   * suggestion however it was proposed.
   */
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

  /**
   * Say what a row is *for* — a ticket somebody fixes, or a documentation change.
   * Guarded on the row being one nothing has taken yet: turning an owned row into a
   * note would leave an agent dispatched for something the board no longer holds.
   * Answers whether the write took.
   */
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

  /**
   * The board as anything that reads it wants it: the row, its keys, how many
   * independent voices carry it, and the goals that have said it. The voice count is
   * {@link obstacleVoices}' own, never a second fold of the sightings.
   */
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
   * How many **independent** voices have said it. A voice is a goal — never an origin
   * and never an agent — or the harness, whose identity is the transition. A sighting
   * with neither counts as itself. Sessions fold too, so a re-dispatch corroborating
   * its own predecessor is one voice.
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
      // Never anything else on a first report: **one report is not evidence**, and is
      // indistinguishable from an agent mis-diagnosing its own breakage.
      state: 'sighted',
      ownerRef: null,
      until: report.untilHours === null ? null : new Date(Date.parse(at) + report.untilHours * 3_600_000).toISOString(),
      createdAt: at,
      updatedAt: at,
      lastSeenAt: at,
      // Nothing has ended it, which is what null says everywhere this column is
      // read — including on every row written before the column existed.
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

  /**
   * Insert this report's keys and answer which obstacle actually holds them.
   * `INSERT OR IGNORE` against the UNIQUE on `value`, then a read back: a value
   * another row owns stays that row's, and the caller follows its sighting there.
   * A suggesting-only key is attached the same way but never resolves one.
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
      // Only a *binding* key may move the report: a signature the board already holds
      // is a suggestion, not a merge.
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
   * Hand one row's keys to another and drop the empty one. Reachable only for a row
   * this same call just created, so nothing with sightings on it is ever folded —
   * that would be the invisible merge no model may make either.
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
   * Move a row, and stamp when it was last seen either way. `last_seen_at` moves on
   * every sighting even where the state does not, because decay reads it.
   */
  private setState(obstacle: Obstacle, state: ObstacleState, at: string): Obstacle {
    // `ended_by` goes back to null with it: no state {@link stateAfterSighting} can
    // write is terminal, so a reopened row must not go on naming an ending.
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
