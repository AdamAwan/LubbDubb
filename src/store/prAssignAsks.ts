import type { PrPerson } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/07-pull-requests.md#asking-who-should-look-at-it

type PrAssignAnswer = { answer: 'assigned'; person: PrPerson } | { answer: 'declined' };

export interface PrAssignment {
  prNumber: number;
  person: PrPerson;
  at: string;
}

export class PrAssignAskStore {
  constructor(private readonly ctx: StoreContext) {}

  recordAssignAnswer(prNumber: number, answer: PrAssignAnswer): void {
    const person = answer.answer === 'assigned' ? answer.person : null;
    this.ctx
      .prep(
        `INSERT INTO pr_assign_asks (pr_number, answer, person_id, person_name, answered_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pr_number) DO NOTHING`,
      )
      .run(prNumber, answer.answer, person?.id ?? null, person?.name ?? null, this.ctx.now());
  }

  answeredPrs(): ReadonlySet<number> {
    const rows = this.ctx.prep(`SELECT pr_number FROM pr_assign_asks`).all() as { pr_number: number }[];
    return new Set(rows.map((r) => r.pr_number));
  }

  assignments(): PrAssignment[] {
    const rows = this.ctx
      .prep(
        `SELECT pr_number, person_id, person_name, answered_at FROM pr_assign_asks
         WHERE answer = 'assigned' AND person_id IS NOT NULL ORDER BY answered_at DESC`,
      )
      .all() as { pr_number: number; person_id: string; person_name: string | null; answered_at: string }[];
    return rows.map((r) => ({
      prNumber: r.pr_number,
      person: { id: r.person_id, name: r.person_name ?? r.person_id },
      at: r.answered_at,
    }));
  }
}
