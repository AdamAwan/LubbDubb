import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';
import type { CostDelta, LocalRun, LocalRunStatus, LocalRunUsageDelta } from '../types.js';

export const LOCAL_RUN_COLUMNS: ColumnMigrations = {
  local_runs: {
    cost_usd: 'REAL',
    input_tokens: 'INTEGER',
    output_tokens: 'INTEGER',
    cache_read_tokens: 'INTEGER',
    cache_creation_tokens: 'INTEGER',
    num_turns: 'INTEGER',
    interrupted_at: 'TEXT',
    last_seen_at: 'TEXT',
  },
};

/**
 * Live means the harness believes something is holding an environment up — including
 * `stopping`, which is a run being taken down and therefore still in the way.
 */
const LIVE: LocalRunStatus[] = ['starting', 'running', 'stopping'];

/**
 * The same set as a SQL fragment, **derived** so it cannot drift from {@link LIVE}.
 *
 * It was written out as `('starting', 'running')` in separate statements here, with
 * `LIVE` beside them read by nobody. Missing a status is silent in both directions:
 * missed by `liveLocalRun` the store lets a second run begin beside a live one, and
 * missed by `beginLocalRun`'s supersede a stopped row is left claiming to be up for
 * ever. Neither errors, and both look like the feature working.
 */
const LIVE_SQL = `(${LIVE.map((s) => `'${s}'`).join(', ')})`;

/**
 * The `local_runs` table: the one dev environment on the operator's machine, and
 * which goal's code is in it.
 *
 * **The mutual exclusion lives here, not in the caller.** `begin` ends whatever was
 * live before it writes the new row, in one transaction — the same shape
 * `claimValidationCheck` uses, and for the same reason: two callers racing must not
 * both read "nothing is running". A runner that checked first and wrote second
 * would compile, pass, and leave two servers fighting over one port with the
 * cockpit showing one of them.
 *
 * Rows are **kept** after the run ends. A start that failed is the case an operator
 * actually hits, and its reason has to be somewhere they can read after the process
 * is gone — a table that deleted the row on stop would leave the panel saying
 * nothing at exactly that moment.
 */
export class LocalRunStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Start a run, ending any that was live first. Returns the row as written.
   *
   * The pid is not an argument: the process does not exist yet. It is written by
   * {@link markLocalRunPid} once the session is spawned, which is also the only
   * moment anything could have gone wrong in between — and a row already in
   * `starting` is what makes that failure visible rather than silent.
   */
  beginLocalRun(input: { originRef: string; ref: string; dir: string; url: string | null }): LocalRun {
    const now = this.ctx.now();
    const run: LocalRun = {
      id: randomUUID(),
      originRef: input.originRef,
      ref: input.ref,
      dir: input.dir,
      pid: null,
      status: 'starting',
      url: input.url,
      note: null,
      startedAt: now,
      endedAt: null,
      interruptedAt: null,
      lastSeenAt: now,
      costUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      numTurns: null,
    };
    const write = this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `UPDATE local_runs SET status = 'stopped', ended_at = ?, note = COALESCE(note, ?)
             WHERE status IN ${LIVE_SQL}`,
        )
        .run(now, 'superseded by a run of another goal');
      this.ctx.db
        .prepare(
          `INSERT INTO local_runs (id, origin_ref, ref, dir, pid, status, url, note, started_at, ended_at,
             last_seen_at)
           VALUES (?, ?, ?, ?, NULL, 'starting', ?, NULL, ?, NULL, ?)`,
        )
        .run(run.id, run.originRef, run.ref, run.dir, run.url, run.startedAt, run.startedAt);
    });
    write();
    return run;
  }

  /** Record the process holding the environment up, so a stop knows whose subtree to reap. */
  markLocalRunPid(id: string, pid: number | null): void {
    this.ctx.db.prepare(`UPDATE local_runs SET pid = ? WHERE id = ?`).run(pid, id);
  }

  /**
   * Stamp when the harness holding this run went down, or clear it because the run
   * is being held again.
   *
   * The one thing a resume can judge a row's age on. `started_at` cannot answer it —
   * an environment an operator brought up on Monday and was still using at five
   * o'clock is not a stale one — and the note the fast stop writes is prose.
   *
   * Cleared on the way back up, because after a resume the stamp describes an
   * interruption that has been answered: left on, the next hard crash would be dated
   * to the *previous* one and a run interrupted a minute ago would read as hours old.
   */
  markLocalRunInterrupted(id: string, at: string | null): void {
    this.ctx.db.prepare(`UPDATE local_runs SET interrupted_at = ? WHERE id = ?`).run(at, id);
  }

  /**
   * Stamp that the harness is still holding this run, as of now.
   *
   * **What dates a force close.** `interrupted_at` is written on the way down, and a
   * `taskkill /F`, an End task, a power cut and a closed console window all take the
   * process without running a line — so on the paths an operator is most likely to
   * take there is no shutdown to stamp anything, and without this the next boot knows
   * only that the row says live. One write per pulse, on one row, keyed by id.
   *
   * Keyed by id and not by "whatever is live" **on purpose**: only the process
   * actually holding the run may date it. A boot that declined to bring a live row
   * back must not stamp it on its way past, or the row it just refused would look
   * freshly held to the boot after that.
   */
  markLocalRunSeen(id: string): void {
    this.ctx.db.prepare(`UPDATE local_runs SET last_seen_at = ? WHERE id = ?`).run(this.ctx.now(), id);
  }

  /**
   * Move a run to its next state. `stopped` and `failed` stamp `ended_at`; `running`
   * leaves it null, because the run is still going.
   */
  setLocalRunStatus(id: string, status: LocalRunStatus, note?: string): void {
    const ended = status === 'stopped' || status === 'failed' ? this.ctx.now() : null;
    this.ctx.db
      .prepare(`UPDATE local_runs SET status = ?, note = COALESCE(?, note), ended_at = ? WHERE id = ?`)
      .run(status, note ?? null, ended, id);
  }

  /** The live run, or null. At most one row can match — {@link beginLocalRun} is what makes that true. */
  liveLocalRun(): LocalRun | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM local_runs WHERE status IN ${LIVE_SQL} ORDER BY started_at DESC LIMIT 1`)
      .get() as LocalRunRow | undefined;
    return row ? toLocalRun(row) : null;
  }

  /**
   * The run to draw: the live one, or the last one that ended.
   *
   * One method rather than two, because the panel asks one question — "what is the
   * state of the local environment" — and "nothing is running, the last attempt
   * failed like this" is an answer to it rather than a different question.
   */
  currentLocalRun(): LocalRun | null {
    const row = this.ctx.db.prepare(`SELECT * FROM local_runs ORDER BY started_at DESC LIMIT 1`).get() as
      | LocalRunRow
      | undefined;
    return row ? toLocalRun(row) : null;
  }

  /**
   * Add one session's usage since its own last report, and date the money.
   *
   * **Adds rather than folds**, which is the one thing here that differs from
   * `recordAgentUsage` and the whole reason this is not that method. An `agents` row
   * has exactly one session behind it, so a cumulative report can be written straight
   * on. A local run has up to two — the session that brought the environment up, and
   * the one spawned to take it down when that one is gone
   * ([23](../../docs/spec/23-local-runs.md#stopping-is-a-turn-not-a-signal)) — and the
   * second one's cumulative total starts at zero. Written on, it would replace a run's
   * $2.00 with $0.15; clamped as a delta, it would report nothing at all. Both are
   * silent, and both under-report the money that was actually spent.
   *
   * A null field adds nothing and leaves the column as it was, so a report carrying a
   * cost and no cache split does not write a zero share — the same distinction
   * `rowToAgent` keeps between an unmeasured column and a measured zero.
   */
  addLocalRunUsage(id: string, delta: LocalRunUsageDelta): void {
    const existing = this.ctx.db
      .prepare(
        `SELECT cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, num_turns
           FROM local_runs WHERE id = ?`,
      )
      .get(id) as LocalRunUsageRow | undefined;
    if (existing === undefined) throw new Error(`Local run ${id} not found`);
    const add = (was: number | null, more: number | null): number | null => (more === null ? was : (was ?? 0) + more);
    this.ctx.db
      .prepare(
        `UPDATE local_runs SET cost_usd = @costUsd, input_tokens = @inputTokens, output_tokens = @outputTokens,
                cache_read_tokens = @cacheReadTokens, cache_creation_tokens = @cacheCreationTokens,
                num_turns = @numTurns WHERE id = @id`,
      )
      .run({
        id,
        costUsd: add(existing.cost_usd, delta.costUsd),
        inputTokens: add(existing.input_tokens, delta.inputTokens),
        outputTokens: add(existing.output_tokens, delta.outputTokens),
        cacheReadTokens: add(existing.cache_read_tokens, delta.cacheReadTokens),
        cacheCreationTokens: add(existing.cache_creation_tokens, delta.cacheCreationTokens),
        numTurns: add(existing.num_turns, delta.numTurns),
      });
    if (delta.costUsd !== null && delta.costUsd > 0)
      this.ctx.db
        .prepare(`INSERT INTO local_run_cost_deltas (local_run_id, cost_usd, at) VALUES (?, ?, ?)`)
        .run(id, delta.costUsd, this.ctx.now());
  }

  /** What local runs have cost since `sinceIso` — half of the rolling window sum. */
  sumLocalRunCostSince(sinceIso: string): number {
    const row = this.ctx.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM local_run_cost_deltas WHERE at >= ?`)
      .get(sinceIso) as { total: number };
    return row.total;
  }

  /** The same rows unaggregated, oldest first — half of the spend timeline. */
  listLocalRunCostDeltasSince(sinceIso: string): CostDelta[] {
    const rows = this.ctx.db
      .prepare(`SELECT cost_usd, at FROM local_run_cost_deltas WHERE at >= ? ORDER BY at`)
      .all(sinceIso) as { cost_usd: number; at: string }[];
    return rows.map((r) => ({ costUsd: r.cost_usd, at: r.at }));
  }

  /**
   * Every run the table holds, newest first — for the spend rollups, which price a
   * goal over its whole history rather than over what is up now.
   */
  listLocalRuns(): LocalRun[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM local_runs ORDER BY started_at DESC`).all() as LocalRunRow[];
    return rows.map(toLocalRun);
  }
}

interface LocalRunRow {
  id: string;
  origin_ref: string;
  ref: string;
  dir: string;
  pid: number | null;
  status: string;
  url: string | null;
  note: string | null;
  started_at: string;
  ended_at: string | null;
  interrupted_at: string | null;
  last_seen_at: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  num_turns: number | null;
}

/** Just the usage columns, for the read {@link LocalRunStore.addLocalRunUsage} adds onto. */
interface LocalRunUsageRow {
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  num_turns: number | null;
}

function toLocalRun(row: LocalRunRow): LocalRun {
  return {
    id: row.id,
    originRef: row.origin_ref,
    ref: row.ref,
    dir: row.dir,
    pid: row.pid,
    status: row.status as LocalRunStatus,
    url: row.url,
    note: row.note,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    interruptedAt: row.interrupted_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
    // Null on every row written before these columns existed, and on every run of a
    // PTY deployment — which has no usage channel at all. Unmeasured, not free.
    costUsd: row.cost_usd ?? null,
    inputTokens: row.input_tokens ?? null,
    outputTokens: row.output_tokens ?? null,
    cacheReadTokens: row.cache_read_tokens ?? null,
    cacheCreationTokens: row.cache_creation_tokens ?? null,
    numTurns: row.num_turns ?? null,
  };
}

/**
 * Date the interruption of the run this boot inherited, on the **one boot**
 * `local_runs.interrupted_at` arrives.
 *
 * Null in that column means "nobody stamped this", which the resume reads as unknown
 * and refuses — the honest answer for a hard crash, and the wrong one for the row an
 * operator is upgrading over right now. That row was left live by a fast stop
 * moments ago, so it is stamped `now` and the boot brings it back exactly as the
 * build before this one would have.
 *
 * Ungated it is the same silence pointed the other way: every stale row would be
 * re-dated to the current boot and resumed for ever.
 *
 * @public — called by `Store`'s constructor, the only place that knows a column was
 * just added.
 */
export function dateInterruptionsFromBeforeTheStamp(db: Database.Database, now: string): void {
  db.prepare(`UPDATE local_runs SET interrupted_at = ? WHERE interrupted_at IS NULL AND status IN ${LIVE_SQL}`).run(
    now,
  );
}

/** Every status a live row can carry, for the callers that ask "is this one going". */
export function localRunIsLive(run: LocalRun): boolean {
  return LIVE.includes(run.status);
}
