import type Database from 'better-sqlite3';
import type { RemoteRunIntent, RemoteRunIntentState } from '../types.js';
import type { ColumnMigrations } from './migrate.js';
import type { StoreContext } from './context.js';

// → docs/spec/36-remote-validation.md#the-ok

export const REMOTE_INTENT_COLUMNS: ColumnMigrations = { remote_run_intents: {} };

interface IntentRow {
  goal_ref: string;
  environment: string;
  state: string;
  fingerprint: string;
  given_at: string;
  run_id: string | null;
  note: string | null;
  updated_at: string;
}

function toIntent(r: IntentRow): RemoteRunIntent {
  return {
    goalRef: r.goal_ref,
    environment: r.environment,
    state: r.state as RemoteRunIntentState,
    fingerprint: r.fingerprint,
    givenAt: r.given_at,
    runId: r.run_id,
    note: r.note,
    updatedAt: r.updated_at,
  };
}

/** `remote_run_intents`. */
export class RemoteIntentStore {
  constructor(private readonly ctx: StoreContext) {}

  /** A new OK replaces whatever the last one was, consumed or withdrawn alike. */
  giveIntent(goalRef: string, environment: string, fingerprint: string): RemoteRunIntent {
    const now = this.ctx.now();
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO remote_run_intents
           (goal_ref, environment, state, fingerprint, given_at, run_id, note, updated_at)
         VALUES (?, ?, 'given', ?, ?, NULL, NULL, ?)`,
      )
      .run(goalRef, environment, fingerprint, now, now);
    return this.getIntent(goalRef, environment)!;
  }

  /** The operator's word that this environment will not be validated for this goal, with their reason. */
  markNotHere(goalRef: string, environment: string, note: string): RemoteRunIntent {
    const now = this.ctx.now();
    this.ctx
      .prep(
        `INSERT OR REPLACE INTO remote_run_intents
           (goal_ref, environment, state, fingerprint, given_at, run_id, note, updated_at)
         VALUES (?, ?, 'not_here', '', ?, NULL, ?, ?)`,
      )
      .run(goalRef, environment, now, note, now);
    return this.getIntent(goalRef, environment)!;
  }

  /** Only a given intent is withdrawn or consumed; the flip is conditional, so a second one finds nothing. */
  withdrawIntent(goalRef: string, environment: string): RemoteRunIntent | null {
    return this.settle(goalRef, environment, 'withdrawn', null);
  }

  consumeIntent(goalRef: string, environment: string, runId: string): RemoteRunIntent | null {
    return this.settle(goalRef, environment, 'consumed', runId);
  }

  /** A given OK the harness took back itself, saying why — the page it was given over is gone. */
  lapseIntent(goalRef: string, environment: string, note: string): RemoteRunIntent | null {
    return this.settle(goalRef, environment, 'withdrawn', null, note);
  }

  /** Why a given intent is still waiting. Written only where it changed, so a quiet pulse writes nothing. */
  noteIntent(goalRef: string, environment: string, note: string | null): void {
    this.ctx
      .prep(
        `UPDATE remote_run_intents SET note=?, updated_at=?
          WHERE goal_ref=? AND environment=? AND state='given' AND note IS NOT ?`,
      )
      .run(note, this.ctx.now(), goalRef, environment, note);
  }

  getIntent(goalRef: string, environment: string): RemoteRunIntent | null {
    const row = this.ctx
      .prep(`SELECT * FROM remote_run_intents WHERE goal_ref=? AND environment=?`)
      .get(goalRef, environment) as IntentRow | undefined;
    return row === undefined ? null : toIntent(row);
  }

  listIntents(): RemoteRunIntent[] {
    const rows = this.ctx
      .prep(`SELECT * FROM remote_run_intents ORDER BY given_at ASC, environment ASC`)
      .all() as IntentRow[];
    return rows.map(toIntent);
  }

  private settle(
    goalRef: string,
    environment: string,
    state: 'withdrawn' | 'consumed',
    runId: string | null,
    note: string | null = null,
  ): RemoteRunIntent | null {
    const changed = this.ctx
      .prep(
        `UPDATE remote_run_intents SET state=?, run_id=?, note=?, updated_at=?
          WHERE goal_ref=? AND environment=? AND state='given'`,
      )
      .run(state, runId, note, this.ctx.now(), goalRef, environment).changes;
    return changed === 0 ? null : this.getIntent(goalRef, environment);
  }
}

/**
 * Ship day. A sheet with no intent reads as one awaiting its OK, so every sheet from before this table
 * is given a consumed one — on the boot that creates the table and never again, because a later boot
 * would consume an OK an operator is waiting on. → docs/spec/14-persistence.md#when-a-null-means-something
 */
export function consumeIntentsForExistingSheets(
  db: Database.Database,
  now: string,
  sheets: readonly { goal_ref: string; environment: string }[],
): void {
  const write = db.prepare(
    `INSERT OR IGNORE INTO remote_run_intents
       (goal_ref, environment, state, fingerprint, given_at, run_id, note, updated_at)
     VALUES (?, ?, 'consumed', '', ?, NULL, NULL, ?)`,
  );
  for (const sheet of sheets) write.run(sheet.goal_ref, sheet.environment, now, now);
}
