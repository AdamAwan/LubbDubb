import { nanoid } from 'nanoid';
import type {
  BotPrRisk,
  BotPrRiskLevel,
  BotPrRiskRun,
  BotPrRiskRunStatus,
  BotPrRiskSubject,
  BotPrRiskTrigger,
  PendingBotPrRiskRun,
} from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/37-bot-prs.md#the-risk-summary

const RUN_COLUMNS = 'id, status, trigger, subjects, task_id, created_at, settled_at';

export class BotPrRiskStore {
  constructor(private readonly ctx: StoreContext) {}

  /** Null when a run is already open: the partial unique index is the lock. */
  openRun(input: { trigger: BotPrRiskTrigger; subjects: BotPrRiskSubject[]; briefing: string }): BotPrRiskRun | null {
    const id = `bpr_${nanoid(10)}`;
    const info = this.ctx
      .prep(
        `INSERT OR IGNORE INTO bot_pr_risk_runs (id, status, trigger, subjects, briefing, created_at)
         VALUES (?, 'pending', ?, ?, ?, ?)`,
      )
      .run(id, input.trigger, JSON.stringify(input.subjects), input.briefing, this.ctx.now());
    return info.changes === 0 ? null : this.getRun(id);
  }

  claimRun(id: string, taskId: string): boolean {
    const info = this.ctx
      .prep(`UPDATE bot_pr_risk_runs SET status='dispatched', task_id=? WHERE id=? AND status='pending'`)
      .run(taskId, id);
    return info.changes > 0;
  }

  settleRun(id: string): void {
    this.ctx
      .prep(`UPDATE bot_pr_risk_runs SET status='done', settled_at=? WHERE id=? AND status!='done'`)
      .run(this.ctx.now(), id);
  }

  getRun(id: string): BotPrRiskRun | null {
    const row = this.ctx.prep(`SELECT ${RUN_COLUMNS} FROM bot_pr_risk_runs WHERE id=?`).get(id) as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  openRunNow(): BotPrRiskRun | null {
    const row = this.ctx
      .prep(`SELECT ${RUN_COLUMNS} FROM bot_pr_risk_runs WHERE status IN ('pending', 'dispatched')`)
      .get() as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  /** The one run waiting for its agent, with the briefing it is dispatched with. */
  pendingRun(): PendingBotPrRiskRun | null {
    const row = this.ctx
      .prep(`SELECT ${RUN_COLUMNS}, briefing FROM bot_pr_risk_runs WHERE status = 'pending'`)
      .get() as (RunRow & { briefing: string }) | undefined;
    return row ? { ...toRun(row), briefing: row.briefing } : null;
  }

  lastRun(): BotPrRiskRun | null {
    const row = this.ctx
      .prep(`SELECT ${RUN_COLUMNS} FROM bot_pr_risk_runs ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get() as RunRow | undefined;
    return row ? toRun(row) : null;
  }

  recordRisk(input: Omit<BotPrRisk, 'assessedAt'>): void {
    this.ctx
      .prep(
        `INSERT INTO bot_pr_risks (pr_number, head_sha, risk, summary, run_id, assessed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_number, head_sha) DO UPDATE SET
           risk = excluded.risk, summary = excluded.summary, run_id = excluded.run_id, assessed_at = excluded.assessed_at`,
      )
      .run(input.prNumber, input.headSha, input.risk, input.summary, input.runId, this.ctx.now());
  }

  /** Every verdict on these pull requests, on whatever head it was written. */
  risksFor(prNumbers: readonly number[]): BotPrRisk[] {
    if (prNumbers.length === 0) return [];
    const marks = prNumbers.map(() => '?').join(', ');
    const rows = this.ctx
      .prep(`SELECT * FROM bot_pr_risks WHERE pr_number IN (${marks})`)
      .all(...prNumbers) as RiskRow[];
    return rows.map((r) => ({
      prNumber: r.pr_number,
      headSha: r.head_sha,
      risk: r.risk as BotPrRiskLevel,
      summary: r.summary,
      runId: r.run_id,
      assessedAt: r.assessed_at,
    }));
  }

  /** The pull requests a run has written a verdict for. */
  assessedIn(runId: string): Set<number> {
    const rows = this.ctx.prep(`SELECT pr_number FROM bot_pr_risks WHERE run_id=?`).all(runId) as {
      pr_number: number;
    }[];
    return new Set(rows.map((r) => r.pr_number));
  }
}

function toRun(r: RunRow): BotPrRiskRun {
  return {
    id: r.id,
    status: r.status as BotPrRiskRunStatus,
    trigger: r.trigger as BotPrRiskTrigger,
    subjects: parseSubjects(r.subjects),
    taskId: r.task_id,
    createdAt: r.created_at,
    settledAt: r.settled_at,
  };
}

function parseSubjects(raw: string): BotPrRiskSubject[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BotPrRiskSubject[]) : [];
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

interface RiskRow {
  pr_number: number;
  head_sha: string;
  risk: string;
  summary: string;
  run_id: string;
  assessed_at: string;
}
