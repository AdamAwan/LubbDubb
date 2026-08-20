import { randomUUID } from 'node:crypto';
import type { StoreContext } from './context.js';
import type { LocalRun, LocalRunStatus } from '../types.js';

/** Live means the harness believes a process is holding an environment up. */
const LIVE: LocalRunStatus[] = ['starting', 'running'];

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
    };
    const write = this.ctx.db.transaction(() => {
      this.ctx.db
        .prepare(
          `UPDATE local_runs SET status = 'stopped', ended_at = ?, note = COALESCE(note, ?)
             WHERE status IN ('starting', 'running')`,
        )
        .run(now, 'superseded by a run of another goal');
      this.ctx.db
        .prepare(
          `INSERT INTO local_runs (id, origin_ref, ref, dir, pid, status, url, note, started_at, ended_at)
           VALUES (?, ?, ?, ?, NULL, 'starting', ?, NULL, ?, NULL)`,
        )
        .run(run.id, run.originRef, run.ref, run.dir, run.url, run.startedAt);
    });
    write();
    return run;
  }

  /** Record the process holding the environment up, so a stop knows whose subtree to reap. */
  markLocalRunPid(id: string, pid: number | null): void {
    this.ctx.db.prepare(`UPDATE local_runs SET pid = ? WHERE id = ?`).run(pid, id);
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
      .prepare(`SELECT * FROM local_runs WHERE status IN ('starting', 'running') ORDER BY started_at DESC LIMIT 1`)
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
   * Mark every live row stopped — the boot sweep.
   *
   * A row saying `running` after a restart is a claim about a process this harness
   * never spawned: the pid belongs to a dead parent, or worse, to something else
   * that has since been given that number. So the boot settles them rather than
   * trusting them, which is the same refusal `claimStaleBefore` makes about a claim
   * whose session no longer exists.
   */
  endStaleLocalRuns(note: string): number {
    const result = this.ctx.db
      .prepare(
        `UPDATE local_runs SET status = 'stopped', ended_at = ?, note = COALESCE(note, ?)
           WHERE status IN ('starting', 'running')`,
      )
      .run(this.ctx.now(), note);
    return result.changes;
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
  };
}

/** Every status a live row can carry, for the callers that ask "is this one going". */
export function localRunIsLive(run: LocalRun): boolean {
  return LIVE.includes(run.status);
}
