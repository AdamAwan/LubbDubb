import type { AppErrorDay, AppErrorDetail, AppErrorGroup, AppErrorRead, AppErrorReadStatus } from '../types.js';
import type { AppErrorGroupWrite, AppErrorMarks } from '../appErrors/groups.js';
import { groupBy } from '../primitives.js';
import type { StoreContext } from './context.js';
import type { ColumnMigrations } from './migrate.js';

// → docs/spec/14-persistence.md, docs/spec/39-app-errors.md

export const APP_ERROR_COLUMNS: ColumnMigrations = {
  app_error_groups: { message: 'TEXT', stack: 'TEXT' },
};

interface GroupInput {
  group: AppErrorGroupWrite;
  days: AppErrorDay[];
}

type ReadInput = Omit<AppErrorRead, 'okAt'>;

export class AppErrorStore {
  constructor(private readonly ctx: StoreContext) {}

  /**
   * One read, written whole: the reading row, every group it named and their day counts. `okAt` moves
   * only on an `ok` read, because it is what the next read's `{since}` is bounded by.
   */
  recordRead(read: ReadInput, groups: GroupInput[]): void {
    this.ctx.db.transaction(() => {
      this.ctx
        .prep(
          `INSERT INTO app_error_reads (environment, status, detail, read_at, ok_at)
           VALUES (@environment, @status, @detail, @readAt, @okAt)
           ON CONFLICT(environment) DO UPDATE SET
             status=excluded.status, detail=excluded.detail, read_at=excluded.read_at,
             ok_at=ifnull(excluded.ok_at, app_error_reads.ok_at)`,
        )
        .run({ ...read, okAt: read.status === 'ok' ? read.readAt : null });
      for (const { group, days } of groups) {
        this.ctx
          .prep(
            `INSERT OR REPLACE INTO app_error_groups
               (environment, fingerprint, title, operation, version, frames, message, stack, url, first_seen, last_seen,
                returned_at)
             VALUES (@environment, @fingerprint, @title, @operation, @version, @frames, @message, @stack, @url,
                @firstSeen, @lastSeen, @returnedAt)`,
          )
          .run({ ...group, frames: JSON.stringify(group.frames) });
        for (const { day, count } of days)
          this.ctx
            .prep(
              `INSERT INTO app_error_days (environment, fingerprint, day, count)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(environment, fingerprint, day) DO UPDATE SET count = count + excluded.count`,
            )
            .run(group.environment, group.fingerprint, day, count);
      }
    })();
  }

  /** Day counts before `dayBefore`, and groups last seen before `seenBefore` with their days. */
  prune(prune: { dayBefore: string; seenBefore: string }): void {
    this.ctx.db.transaction(() => {
      this.ctx.prep(`DELETE FROM app_error_days WHERE day < ?`).run(prune.dayBefore);
      this.ctx.prep(`DELETE FROM app_error_groups WHERE last_seen < ?`).run(prune.seenBefore);
      this.ctx
        .prep(
          `DELETE FROM app_error_days WHERE NOT EXISTS (
             SELECT 1 FROM app_error_groups g
             WHERE g.environment = app_error_days.environment AND g.fingerprint = app_error_days.fingerprint)`,
        )
        .run();
    })();
  }

  getRead(environment: string): AppErrorRead | null {
    const row = this.ctx.prep(`SELECT * FROM app_error_reads WHERE environment = ?`).get(environment) as
      ReadRow | undefined;
    return row === undefined ? null : readOf(row);
  }

  listReads(): AppErrorRead[] {
    return (this.ctx.prep(`SELECT * FROM app_error_reads ORDER BY environment`).all() as ReadRow[]).map(readOf);
  }

  /** What a read merges into, by fingerprint — the held span and return mark, and nothing else. */
  groupMarks(environment: string): Map<string, AppErrorMarks> {
    const rows = this.ctx
      .prep(`SELECT fingerprint, first_seen, last_seen, returned_at FROM app_error_groups WHERE environment = ?`)
      .all(environment) as Pick<GroupRow, 'fingerprint' | 'first_seen' | 'last_seen' | 'returned_at'>[];
    return new Map(
      rows.map((r) => [r.fingerprint, { firstSeen: r.first_seen, lastSeen: r.last_seen, returnedAt: r.returned_at }]),
    );
  }

  getDetail(environment: string, fingerprint: string): AppErrorDetail | null {
    const row = this.ctx
      .prep(`SELECT message, stack FROM app_error_groups WHERE environment = ? AND fingerprint = ?`)
      .get(environment, fingerprint) as AppErrorDetail | undefined;
    return row ?? null;
  }

  listGroups(): AppErrorGroup[] {
    const groups = this.ctx
      .prep(
        `SELECT environment, fingerprint, title, operation, version, frames, url, first_seen, last_seen, returned_at,
                (message IS NOT NULL OR stack IS NOT NULL) AS has_detail
               FROM app_error_groups ORDER BY environment, last_seen DESC`,
      )
      .all() as GroupRow[];
    const days = groupBy(
      this.ctx.prep(`SELECT * FROM app_error_days ORDER BY day`).all() as DayRow[],
      (d) => `${d.environment}\n${d.fingerprint}`,
    );
    return groups.map((g) => ({
      environment: g.environment,
      fingerprint: g.fingerprint,
      title: g.title,
      operation: g.operation,
      version: g.version,
      frames: readFrames(g.frames),
      hasDetail: g.has_detail === 1,
      url: g.url,
      firstSeen: g.first_seen,
      lastSeen: g.last_seen,
      returnedAt: g.returned_at,
      daily: (days.get(`${g.environment}\n${g.fingerprint}`) ?? []).map((d) => ({ day: d.day, count: d.count })),
    }));
  }
}

interface ReadRow {
  environment: string;
  status: string;
  detail: string | null;
  read_at: string;
  ok_at: string | null;
}

function readOf(r: ReadRow): AppErrorRead {
  return {
    environment: r.environment,
    status: r.status as AppErrorReadStatus,
    detail: r.detail,
    readAt: r.read_at,
    okAt: r.ok_at,
  };
}

interface GroupRow {
  environment: string;
  fingerprint: string;
  title: string;
  operation: string | null;
  version: string | null;
  frames: string;
  has_detail: number;
  url: string | null;
  first_seen: string;
  last_seen: string;
  returned_at: string | null;
}

interface DayRow {
  environment: string;
  fingerprint: string;
  day: string;
  count: number;
}

function readFrames(text: string): string[] {
  const json: unknown = JSON.parse(text);
  return Array.isArray(json) ? json.filter((f): f is string => typeof f === 'string') : [];
}
