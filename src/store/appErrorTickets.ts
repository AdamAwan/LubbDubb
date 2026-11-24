import type { AppErrorDismissal, AppErrorTicketSearch, AppErrorTrackerStatus } from '../types.js';
import type { StoreContext } from './context.js';

// → docs/spec/14-persistence.md, docs/spec/39-app-errors.md#the-tracker-lock

export class AppErrorTicketStore {
  constructor(private readonly ctx: StoreContext) {}

  recordSearches(searches: readonly AppErrorTicketSearch[]): void {
    this.ctx.db.transaction(() => {
      for (const s of searches)
        this.ctx
          .prep(
            `INSERT OR REPLACE INTO app_error_tickets
               (error_key, status, ticket_ref, closed_at, tickets, detail, checked_at)
             VALUES (@key, @status, @ticketRef, @closedAt, @tickets, @detail, @checkedAt)`,
          )
          .run(s);
    })();
  }

  listSearches(): AppErrorTicketSearch[] {
    return (this.ctx.prep(`SELECT * FROM app_error_tickets ORDER BY error_key`).all() as SearchRow[]).map(searchOf);
  }

  /** The operator's "Not it": the error under `key` was not caused by `goalRef`. → docs/spec/39-app-errors.md#not-it */
  dismiss(key: string, goalRef: string, at: string): void {
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO app_error_dismissals (error_key, goal_ref, dismissed_at)
         VALUES (?, ?, ?)`,
      )
      .run(key, goalRef, at);
  }

  listDismissals(): AppErrorDismissal[] {
    const rows = this.ctx
      .prep(`SELECT error_key, goal_ref, dismissed_at FROM app_error_dismissals ORDER BY error_key, goal_ref`)
      .all() as { error_key: string; goal_ref: string; dismissed_at: string }[];
    return rows.map((r) => ({ key: r.error_key, goalRef: r.goal_ref, at: r.dismissed_at }));
  }
}

interface SearchRow {
  error_key: string;
  status: string;
  ticket_ref: string | null;
  closed_at: string | null;
  tickets: number;
  detail: string | null;
  checked_at: string;
}

function searchOf(r: SearchRow): AppErrorTicketSearch {
  return {
    key: r.error_key,
    status: r.status as AppErrorTrackerStatus,
    ticketRef: r.ticket_ref,
    closedAt: r.closed_at,
    tickets: r.tickets,
    detail: r.detail,
    checkedAt: r.checked_at,
  };
}
