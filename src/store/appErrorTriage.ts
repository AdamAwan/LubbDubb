import { nanoid } from 'nanoid';
import type {
  AppErrorState,
  AppErrorTriageConfidence,
  AppErrorTriageRun,
  AppErrorTriageRunStatus,
  AppErrorTriageSubject,
  AppErrorTriageTrigger,
  AppErrorTriageVerdict,
  PendingAppErrorTriageRun,
} from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/39-app-errors.md#agent-triage

const RUN_COLUMNS = 'id, status, trigger, subjects, task_id, created_at, settled_at';

/** The identity of a group's episode: what a verdict and a detail read are keyed on. */
export type TriageEpisode = Pick<AppErrorTriageSubject, 'environment' | 'fingerprint' | 'state' | 'anchor'>;

/** One stored verdict, with the episode it is about. */
export interface StoredTriage extends TriageEpisode {
  key: string;
  verdict: AppErrorTriageVerdict;
  goalRef: string | null;
  confidence: AppErrorTriageConfidence;
  reason: string;
  runId: string;
  at: string;
}

export class AppErrorTriageStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Null when a run is already open: the partial unique index is the lock. */
  openRun(input: {
    trigger: AppErrorTriageTrigger;
    subjects: AppErrorTriageSubject[];
    briefing: string;
  }): AppErrorTriageRun | null {
    const id = `aet_${nanoid(10)}`;
    const info = this.ctx
      .prep(
        `INSERT OR IGNORE INTO app_error_triage_runs (id, status, trigger, subjects, briefing, created_at)
         VALUES (?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, input.trigger, JSON.stringify(input.subjects), input.briefing, this.ctx.now());
    return info.changes === 0 ? null : this.getRun(id);
  }

  claimRun(id: string, taskId: string): boolean {
    const info = this.ctx
      .prep(`UPDATE app_error_triage_runs SET status='dispatched', task_id=? WHERE id=? AND status='pending'`)
      .run(taskId, id);
    return info.changes > 0;
  }

  settleRun(id: string): void {
    this.ctx
      .prep(`UPDATE app_error_triage_runs SET status='done', settled_at=? WHERE id=? AND status!='done'`)
      .run(this.ctx.now(), id);
  }

  getRun(id: string): AppErrorTriageRun | null {
    const row = this.ctx.prep(`SELECT ${RUN_COLUMNS} FROM app_error_triage_runs WHERE id=?`).get(id) as
      RunRow | undefined;
    return row ? toRun(row) : null;
  }

  openRunNow(): AppErrorTriageRun | null {
    const row = this.ctx
      .prep(`SELECT ${RUN_COLUMNS} FROM app_error_triage_runs WHERE status IN ('pending', 'dispatched')`)
      .get() as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The one run waiting for its agent, with the briefing it is dispatched with. */
  pendingRun(): PendingAppErrorTriageRun | null {
    const row = this.ctx
      .prep(`SELECT ${RUN_COLUMNS}, briefing FROM app_error_triage_runs WHERE status = 'pending'`)
      .get() as (RunRow & { briefing: string }) | undefined;
    return row ? { ...toRun(row), briefing: row.briefing } : null;
  }

  lastRun(): AppErrorTriageRun | null {
    const row = this.ctx
      .prep(`SELECT ${RUN_COLUMNS} FROM app_error_triage_runs ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get() as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** How many groups automatic runs opened since `since` put in front of an agent: what the daily cap counts. */
  autoSubjectsSince(since: string): number {
    const rows = this.ctx
      .prep(`SELECT subjects FROM app_error_triage_runs WHERE trigger = 'auto' AND created_at >= ?`)
      .all(since) as { subjects: string }[];
    return rows.reduce((n, r) => n + parseSubjects(r.subjects).length, 0);
  }

  /** One verdict per episode: a second answer on the same episode replaces the first. */
  recordVerdict(input: Omit<StoredTriage, 'at'>): void {
    this.ctx
      .prep(
        `INSERT INTO app_error_triages
           (environment, fingerprint, state, anchor, error_key, verdict, goal_ref, confidence, reason, run_id, at)
         VALUES (@environment, @fingerprint, @state, @anchor, @key, @verdict, @goalRef, @confidence, @reason, @runId, @at)
         ON CONFLICT(environment, fingerprint, state, anchor) DO UPDATE SET
           error_key = excluded.error_key, verdict = excluded.verdict, goal_ref = excluded.goal_ref,
           confidence = excluded.confidence, reason = excluded.reason, run_id = excluded.run_id, at = excluded.at`,
      )
      .run({ ...input, at: this.ctx.now() });
  }

  listTriages(): StoredTriage[] {
    return (this.ctx.prep(`SELECT * FROM app_error_triages`).all() as TriageRow[]).map((r) => ({
      environment: r.environment,
      fingerprint: r.fingerprint,
      state: r.state as AppErrorState,
      anchor: r.anchor,
      key: r.error_key,
      verdict: r.verdict as AppErrorTriageVerdict,
      goalRef: r.goal_ref,
      confidence: r.confidence as AppErrorTriageConfidence,
      reason: r.reason,
      runId: r.run_id,
      at: r.at,
    }));
  }

  /** The keys a run has written a verdict for. */
  answeredIn(runId: string): Set<string> {
    const rows = this.ctx.prep(`SELECT error_key FROM app_error_triages WHERE run_id = ?`).all(runId) as {
      error_key: string;
    }[];
    return new Set(rows.map((r) => r.error_key));
  }

  recordDetailRead(input: TriageEpisode & { key: string; runId: string; taskId: string }): void {
    this.ctx
      .prep(
        `INSERT INTO app_error_detail_reads (error_key, environment, fingerprint, state, anchor, run_id, task_id, at)
         VALUES (@key, @environment, @fingerprint, @state, @anchor, @runId, @taskId, @at)`,
      )
      .run({
        key: input.key,
        environment: input.environment,
        fingerprint: input.fingerprint,
        state: input.state,
        anchor: input.anchor,
        runId: input.runId,
        taskId: input.taskId,
        at: this.ctx.now(),
      });
  }

  /** The latest detail read per episode. */
  listDetailReads(): (TriageEpisode & { at: string })[] {
    return (
      this.ctx
        .prep(
          `SELECT environment, fingerprint, state, anchor, MAX(at) AS at FROM app_error_detail_reads
           GROUP BY environment, fingerprint, state, anchor`,
        )
        .all() as { environment: string; fingerprint: string; state: string; anchor: string; at: string }[]
    ).map((r) => ({ ...r, state: r.state as AppErrorState }));
  }

  /** Verdicts and reads whose group is no longer held, and runs settled before `settledBefore`. */
  prune(settledBefore: string, held: ReadonlySet<string>): void {
    this.ctx.db.transaction(() => {
      for (const table of ['app_error_triages', 'app_error_detail_reads']) {
        const rows = this.ctx.prep(`SELECT DISTINCT environment, fingerprint FROM ${table}`).all() as {
          environment: string;
          fingerprint: string;
        }[];
        for (const r of rows)
          if (!held.has(`${r.environment}\u0000${r.fingerprint}`))
            this.ctx
              .prep(`DELETE FROM ${table} WHERE environment = ? AND fingerprint = ?`)
              .run(r.environment, r.fingerprint);
      }
      this.ctx.prep(`DELETE FROM app_error_triage_runs WHERE status = 'done' AND settled_at < ?`).run(settledBefore);
    })();
  }
}

function toRun(r: RunRow): AppErrorTriageRun {
  return {
    id: r.id,
    status: r.status as AppErrorTriageRunStatus,
    trigger: r.trigger as AppErrorTriageTrigger,
    subjects: parseSubjects(r.subjects),
    taskId: r.task_id,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

function parseSubjects(raw: string): AppErrorTriageSubject[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AppErrorTriageSubject[]) : [];
  } catch {
    return [];
  }
}

interface RunRow {
  id: string;
  status: string;
  trigger: string;
  subjects: string;
  task_id: string | null;
  created_at: string;
  settled_at: string | null;
}

interface TriageRow {
  environment: string;
  fingerprint: string;
  state: string;
  anchor: string;
  error_key: string;
  verdict: string;
  goal_ref: string | null;
  confidence: string;
  reason: string;
  run_id: string;
  at: string;
}
