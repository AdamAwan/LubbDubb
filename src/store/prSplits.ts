import type { PrSplitVerdict, PrSplitVerdictInput, PrSplitVerdictKind } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class PrSplitStore {
  constructor(private readonly ctx: StoreContext) {}

  recordPrSplitVerdict(input: PrSplitVerdictInput): PrSplitVerdict {
    const decidedAt = this.ctx.now();
    this.ctx.db
      .prepare(
        `INSERT INTO pr_splits (pr_number, issue_number, verdict, concepts, reason, files, agent_id, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_number) DO UPDATE SET
           issue_number = excluded.issue_number,
           verdict = excluded.verdict,
           concepts = excluded.concepts,
           reason = excluded.reason,
           files = excluded.files,
           agent_id = excluded.agent_id,
           decided_at = excluded.decided_at`,
      )
      .run(
        input.prNumber,
        input.issueNumber,
        input.verdict,
        JSON.stringify(input.concepts),
        input.reason,
        input.files,
        input.agentId,
        decidedAt,
      );
    return { ...input, decidedAt };
  }

  listPrSplitVerdicts(): PrSplitVerdict[] {
    const rows = this.ctx.db.prepare(`SELECT * FROM pr_splits ORDER BY decided_at DESC`).all() as Row[];
    return rows.map((row) => ({
      prNumber: row.pr_number,
      issueNumber: row.issue_number,
      verdict: row.verdict as PrSplitVerdictKind,
      concepts: parseConcepts(row.concepts),
      reason: row.reason,
      files: row.files,
      agentId: row.agent_id,
      decidedAt: row.decided_at,
    }));
  }
}

function parseConcepts(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

interface Row {
  pr_number: number;
  issue_number: number;
  verdict: string;
  concepts: string;
  reason: string;
  files: number;
  agent_id: string | null;
  decided_at: string;
}
