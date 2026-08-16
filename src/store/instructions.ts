import { nanoid } from 'nanoid';
import type { IssueInstruction } from '../types.js';
import type { StoreContext } from './context.js';

/**
 * The `issue_instructions` table: what the operator has told the fleet to do on a
 * goal, in their own words.
 *
 * Deliberately **not** in {@link file://./issueVerdicts.ts}. Everything there is a
 * verdict — one row per issue, overwritten per declaration, read by a gate — and
 * an instruction is none of those: it is input, it accumulates, and nothing
 * branches on it. Filing it beside the verdicts would put a growing list under
 * the one module whose whole discipline is that each of its tables holds exactly
 * one standing answer.
 */
export class InstructionStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * Write one instruction. Append-only: there is no update beside this for the
   * pad's reason — a revised instruction would leave a record of what the
   * operator ended up asking for rather than what the agent was actually handed,
   * and the two differ exactly when something went wrong.
   */
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

  /**
   * One goal's standing instructions, oldest first — the order they were written
   * in, which is the order they read in. Ties break on **rowid** for
   * `listScratchEntries`'s reason: two rows written in the same millisecond would
   * otherwise come back in the order their nanoids happen to sort in.
   */
  listStandingInstructions(originRef: string): IssueInstruction[] {
    const rows = this.ctx.db
      .prepare(
        `SELECT * FROM issue_instructions WHERE origin_ref=? AND settled_at IS NULL
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(originRef) as InstructionRow[];
    return rows.map(toInstruction);
  }

  /**
   * Every goal's standing instructions in one query, for the snapshot. Per-issue
   * reads are what `listScratchPadSummaries` refuses for the same reason: this is
   * read on every `/api/state` poll, and a read per goal would scale the poll
   * with the size of the backlog to say nothing more.
   */
  listAllStandingInstructions(): IssueInstruction[] {
    const rows = this.ctx.db
      .prepare(`SELECT * FROM issue_instructions WHERE settled_at IS NULL ORDER BY created_at ASC, rowid ASC`)
      .all() as InstructionRow[];
    return rows.map(toInstruction);
  }

  /**
   * Settle every standing instruction on a goal, returning how many there were.
   *
   * Called when an agent concludes the goal — its `conclude_work` note is the
   * answer to whatever was standing, and the note reaches the next agent through
   * `outstandingWorkNote`. Settling on *dispatch* instead would lose an
   * instruction the moment an agent died before doing anything with it, which is
   * the failure this row shape exists to avoid.
   */
  settleInstructions(originRef: string): number {
    const at = this.ctx.now();
    const result = this.ctx.db
      .prepare(`UPDATE issue_instructions SET settled_at=? WHERE origin_ref=? AND settled_at IS NULL`)
      .run(at, originRef);
    return result.changes;
  }

  /** The operator taking one back. False when it does not exist or already settled. */
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
