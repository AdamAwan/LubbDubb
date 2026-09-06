import { nanoid } from 'nanoid';
import type { IssueInstruction } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export class InstructionStore {
  constructor(private readonly ctx: StoreContext) {}

  addIssueInstruction(input: { originRef: string; text: string }): IssueInstruction {
    const row: IssueInstruction = {
      id: `ins_${nanoid(10)}`,
      ...input,
      createdAt: this.ctx.now(),
      settledAt: null,
    };
    this.ctx.db
      .prepare(
        `INSERT INTO issue_instructions (id, origin_ref, text, created_at, settled_at)
         VALUES (@id, @originRef, @text, @createdAt, @settledAt)`,
      )
      .run(row);
    return row;
  }

  listStandingInstructions(originRef: string): IssueInstruction[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM issue_instructions WHERE origin_ref=? AND settled_at IS NULL
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(originRef) as InstructionRow[];
    return rows.map(toInstruction);
  }

  listAllStandingInstructions(): IssueInstruction[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM issue_instructions WHERE settled_at IS NULL ORDER BY created_at ASC, rowid ASC`)
      .all() as InstructionRow[];
    return rows.map(toInstruction);
  }

  settleInstructions(originRef: string): number {
    const at = this.ctx.now();
    const result = this.ctx.db
      .prepare(`UPDATE issue_instructions SET settled_at=? WHERE origin_ref=? AND settled_at IS NULL`)
      .run(at, originRef);
    return result.changes;
  }

  withdrawInstruction(id: string): boolean {
    const result = this.ctx.db
      .prepare(`UPDATE issue_instructions SET settled_at=? WHERE id=? AND settled_at IS NULL`)
      .run(this.ctx.now(), id);
    return result.changes > 0;
  }
}

interface InstructionRow {
  id: string;
  origin_ref: string;
  text: string;
  created_at: string;
  settled_at: string | null;
}

function toInstruction(row: InstructionRow): IssueInstruction {
  return {
    id: row.id,
    originRef: row.origin_ref,
    text: row.text,
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}
