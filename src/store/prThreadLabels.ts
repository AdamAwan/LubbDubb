import type { PrThreadLabel, PrThreadLabelInput } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md

export const PR_THREAD_LABEL_COLUMNS: ColumnMigrations = {
  pr_thread_labels: {
    author_is_bot: 'INTEGER',
  },
};

export class PrThreadLabelStore {
  constructor(private readonly ctx: StoreContext) {}

  recordThreadLabel(input: PrThreadLabelInput): PrThreadLabel {
    const answeredAt = this.ctx.now();
    this.ctx
      .prep(
        `INSERT INTO pr_thread_labels
           (pr_number, thread_id, about_comment, changed_code, resolved, path, author, author_is_bot, agent_id, task_id, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pr_number, thread_id) DO UPDATE SET
           about_comment = excluded.about_comment,
           changed_code = excluded.changed_code,
           resolved = excluded.resolved,
           path = excluded.path,
           author = excluded.author,
           author_is_bot = excluded.author_is_bot,
           agent_id = excluded.agent_id,
           task_id = excluded.task_id,
           answered_at = excluded.answered_at`,
      )
      .run(
        input.prNumber,
        input.threadId,
        input.aboutComment ? 1 : 0,
        input.changedCode ? 1 : 0,
        input.resolved ? 1 : 0,
        input.path,
        input.author,
        input.authorIsBot === null ? null : input.authorIsBot ? 1 : 0,
        input.agentId,
        input.taskId,
        answeredAt,
      );
    return { ...input, answeredAt };
  }

  listThreadLabelsSince(since: string): PrThreadLabel[] {
    const rows = this.ctx
      .prep(`SELECT * FROM pr_thread_labels WHERE answered_at >= ? ORDER BY answered_at ASC, rowid ASC`)
      .all(since) as Row[];
    return rows.map(hydrate);
  }
}

interface Row {
  pr_number: number;
  thread_id: string;
  about_comment: number;
  changed_code: number;
  resolved: number;
  path: string | null;
  author: string | null;
  author_is_bot: number | null;
  agent_id: string;
  task_id: string;
  answered_at: string;
}

function hydrate(row: Row): PrThreadLabel {
  return {
    prNumber: row.pr_number,
    threadId: row.thread_id,
    aboutComment: row.about_comment === 1,
    changedCode: row.changed_code === 1,
    resolved: row.resolved === 1,
    path: row.path,
    author: row.author,
    authorIsBot: row.author_is_bot === null ? null : row.author_is_bot === 1,
    agentId: row.agent_id,
    taskId: row.task_id,
    answeredAt: row.answered_at,
  };
}
