import type { BotPrOutcome, BotPrOutcomeKind } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/37-bot-prs.md#when-ci-fails-on-one

export class BotPrOutcomeStore {
  constructor(private readonly ctx: StoreContext) {}

  record(input: Omit<BotPrOutcome, 'recordedAt'> & { taskId: string }): BotPrOutcome {
    const recordedAt = this.ctx.now();
    this.ctx
      .prep(
        `INSERT INTO bot_pr_outcomes (pr_number, head_sha, outcome, summary, upstream_url, fixed_in, task_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_number, head_sha) DO UPDATE SET
           outcome = excluded.outcome, summary = excluded.summary, upstream_url = excluded.upstream_url,
           fixed_in = excluded.fixed_in, task_id = excluded.task_id, recorded_at = excluded.recorded_at`,
      )
      .run(
        input.prNumber,
        input.headSha,
        input.outcome,
        input.summary,
        input.upstreamUrl,
        input.fixedIn,
        input.taskId,
        recordedAt,
      );
    return {
      prNumber: input.prNumber,
      headSha: input.headSha,
      outcome: input.outcome,
      summary: input.summary,
      upstreamUrl: input.upstreamUrl,
      fixedIn: input.fixedIn,
      recordedAt,
    };
  }

  /** The latest outcome on each of these pull requests, on whatever head it was recorded. */
  latestFor(prNumbers: readonly number[]): BotPrOutcome[] {
    if (prNumbers.length === 0) return [];
    const marks = prNumbers.map(() => '?').join(', ');
    const rows = this.ctx
      .prep(`SELECT * FROM bot_pr_outcomes WHERE pr_number IN (${marks}) ORDER BY recorded_at DESC, rowid DESC`)
      .all(...prNumbers) as OutcomeRow[];
    const latest = new Map<number, BotPrOutcome>();
    for (const row of rows) if (!latest.has(row.pr_number)) latest.set(row.pr_number, toOutcome(row));
    return [...latest.values()];
  }

  /** Every outcome on these exact heads. */
  onHeads(heads: readonly { prNumber: number; headSha: string }[]): BotPrOutcome[] {
    if (heads.length === 0) return [];
    const wanted = new Set(heads.map((h) => `${String(h.prNumber)}@${h.headSha}`));
    const marks = heads.map(() => '?').join(', ');
    const rows = this.ctx
      .prep(`SELECT * FROM bot_pr_outcomes WHERE pr_number IN (${marks})`)
      .all(...heads.map((h) => h.prNumber)) as OutcomeRow[];
    return rows.filter((r) => wanted.has(`${String(r.pr_number)}@${r.head_sha}`)).map(toOutcome);
  }
}

function toOutcome(r: OutcomeRow): BotPrOutcome {
  return {
    prNumber: r.pr_number,
    headSha: r.head_sha,
    outcome: r.outcome as BotPrOutcomeKind,
    summary: r.summary,
    upstreamUrl: r.upstream_url,
    fixedIn: r.fixed_in,
    recordedAt: r.recorded_at,
  };
}

interface OutcomeRow {
  pr_number: number;
  head_sha: string;
  outcome: string;
  summary: string;
  upstream_url: string | null;
  fixed_in: string | null;
  recorded_at: string;
}
