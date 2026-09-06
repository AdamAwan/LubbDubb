import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';
import type { CostDelta, LocalRun, LocalRunStatus, LocalRunUsageDelta } from '../types.js';

// → docs/spec/14-persistence.md

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
    commit_sha: 'TEXT',
  },
};

const LIVE: LocalRunStatus[] = ['starting', 'running', 'stopping'];

const LIVE_SQL = `(${LIVE.map((s) => `'${s}'`).join(', ')})`;

export class LocalRunStore {
  constructor(private readonly ctx: StoreContext) {}

  beginLocalRun(input: { originRef: string; ref: string; dir: string; commit: string; url: string | null }): LocalRun {
    const now = this.ctx.now();
    const run: LocalRun = {
      id: randomUUID(),
      originRef: input.originRef,
      ref: input.ref,
      dir: input.dir,
      commit: input.commit,
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
             last_seen_at, commit_sha)
           VALUES (?, ?, ?, ?, NULL, 'starting', ?, NULL, ?, NULL, ?, ?)`,
        )
        .run(run.id, run.originRef, run.ref, run.dir, run.url, run.startedAt, run.startedAt, run.commit);
    });
    write();
    return run;
  }

  setLocalRunCommit(id: string, commit: string): void {
    this.ctx.db.prepare(`UPDATE local_runs SET commit_sha = ? WHERE id = ?`).run(commit, id);
  }

  markLocalRunPid(id: string, pid: number | null): void {
    this.ctx.db.prepare(`UPDATE local_runs SET pid = ? WHERE id = ?`).run(pid, id);
  }

  markLocalRunInterrupted(id: string, at: string | null): void {
    this.ctx.db.prepare(`UPDATE local_runs SET interrupted_at = ? WHERE id = ?`).run(at, id);
  }

  markLocalRunSeen(id: string, at: string): void {
    this.ctx.db.prepare(`UPDATE local_runs SET last_seen_at = ? WHERE id = ?`).run(at, id);
  }

  setLocalRunStatus(id: string, status: LocalRunStatus, note?: string): void {
    const ended = status === 'stopped' || status === 'failed' ? this.ctx.now() : null;
    this.ctx.db
      .prepare(`UPDATE local_runs SET status = ?, note = COALESCE(?, note), ended_at = ? WHERE id = ?`)
      .run(status, note ?? null, ended, id);
  }

  liveLocalRun(): LocalRun | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM local_runs WHERE status IN ${LIVE_SQL} ORDER BY started_at DESC LIMIT 1`)
      .get() as LocalRunRow | undefined;
    return row ? toLocalRun(row) : null;
  }

  currentLocalRun(): LocalRun | null {
    const row = this.ctx.db.prepare(`SELECT * FROM local_runs ORDER BY started_at DESC LIMIT 1`).get() as
      | LocalRunRow
      | undefined;
    return row ? toLocalRun(row) : null;
  }

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

  sumLocalRunCostSince(sinceIso: string): number {
    const row = this.ctx.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM local_run_cost_deltas WHERE at >= ?`)
      .get(sinceIso) as { total: number };
    return row.total;
  }

  listLocalRunCostDeltasSince(sinceIso: string): CostDelta[] {
    const rows = this.ctx.db
      .prepare(`SELECT cost_usd, at FROM local_run_cost_deltas WHERE at >= ? ORDER BY at`)
      .all(sinceIso) as { cost_usd: number; at: string }[];
    return rows.map((r) => ({ costUsd: r.cost_usd, at: r.at }));
  }

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
  commit_sha: string | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  num_turns: number | null;
}

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
    commit: row.commit_sha ?? null,
    pid: row.pid,
    status: row.status as LocalRunStatus,
    url: row.url,
    note: row.note,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    interruptedAt: row.interrupted_at ?? null,
    lastSeenAt: row.last_seen_at ?? null,
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

export function localRunIsLive(run: LocalRun): boolean {
  return LIVE.includes(run.status);
}
